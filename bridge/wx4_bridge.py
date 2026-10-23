"""微信 4.x 桥 —— 基于 wxauto4(Windows UIA),不再截屏 OCR。

为什么换掉 OCR 那版:微信 4.1 的 mmui 界面读不到 UIA 树,只能「看屏幕 + 点鼠标」,
分块坐标随 DPI/窗口大小漂,读消息靠猜。wxauto4 把 4.1.x 的 UIA 摸通了,
消息带 sender/type/timestr,发送也稳,就不必自己造轮子了。

协议(一行一条 JSON):
    ← {"id":1,"op":"chats","limit":20}
    → {"id":1,"ok":true,"result":[...]}
    → {"event":"state","state":"ready"|"error: ..."}
    → {"event":"message","chat":"阿黄","sender":"阿黄","text":"...","time":"..."}

所有 UIA 调用都跑在主线程里(wxauto 用 COM,跨线程会闹脾气):
一个喂食线程只负责把 stdin 的行塞进队列,主线程边处理请求边轮询新消息。
"""

from __future__ import annotations

import io
import json
import os
import queue
import re
import sys
import threading
import time

# wxauto / 别的库偶尔会 print,别让它污染协议流:真 stdout 先扣下,其余人一律看 stderr。
_REAL_OUT = sys.stdout


def emit(obj: dict) -> None:
    try:
        _REAL_OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
        _REAL_OUT.flush()
    except Exception:  # noqa: BLE001
        pass


sys.stdout = sys.stderr
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

POLL_SECONDS = float(os.environ.get("WX_POLL_SECONDS", "8"))
WATCH = [w for w in os.environ.get("WX_WATCH", "").split(",") if w.strip()]
# 收到图片/语音时要不要回头把它抓成一张 png(会短暂切一下会话)。WX_CAPTURE=0 关掉。
CAPTURE_MEDIA = os.environ.get("WX_CAPTURE", "1") not in ("0", "false", "off")


def log(*a) -> None:
    print("[wx4]", *a, file=sys.stderr, flush=True)


# --- 微信实例 ---------------------------------------------------------------

wx = None
_me: dict = {}


def connect() -> bool:
    global wx, _me
    from wxauto4 import WeChat

    try:
        wx = WeChat(ads=False)  # ads=False 关掉免费版的推广横幅,别混进 stderr
    except TypeError:
        wx = WeChat()
    try:
        _me = wx.GetMyInfo() or {}
    except Exception:  # noqa: BLE001
        _me = {}
    return True


# --- 各个 op ----------------------------------------------------------------

def op_ping(_args: dict) -> dict:
    return {"pong": True, "me": _me, "online": bool(wx and wx.IsOnline())}


def op_chats(args: dict) -> list:
    limit = int(args.get("limit") or 20)
    out = []
    for s in wx.GetSession():
        try:
            out.append({
                "name": s.name,
                "preview": getattr(s, "content", "") or "",
                "unread": getattr(s, "new_count", None),
                "time": str(getattr(s, "time", "") or ""),
            })
        except Exception as err:  # noqa: BLE001
            log("session 读不动:", err)
    return out[:limit]


def op_read(args: dict) -> list:
    chat = (args.get("chat") or "").strip()
    limit = int(args.get("limit") or 20)
    if not chat:
        raise ValueError("要给一个会话名")
    wx.ChatWith(chat, exact=False)
    time.sleep(0.3)
    info = wx.ChatInfo() or {}
    if not info.get("chat_name"):
        raise RuntimeError(f"没打开「{chat}」")
    out = []
    for m in wx.GetAllMessage():
        raw = getattr(m, "raw", None) or {}
        if raw.get("type") == "time":
            continue
        out.append({
            "sender": raw.get("sender") or "",
            "text": raw.get("content") or "",
            "time": raw.get("timestr") or "",
            "type": raw.get("type") or "",
        })
    return out[-limit:]


def op_send(args: dict) -> dict:
    chat = (args.get("chat") or "").strip()
    text = args.get("text") or ""
    if not chat:
        raise ValueError("要给一个会话名")
    if not text:
        raise ValueError("要发的内容是空的")
    resp = wx.SendMsg(msg=text, who=chat, exact=False)
    ok = bool(getattr(resp, "is_success", None))
    _sent_recent[text] = time.time()
    _seen[_norm(text)] = time.time()
    return {"sent": ok, "chat": chat, "detail": str(resp)[:200]}


def op_quit(_args: dict) -> dict:
    raise SystemExit(0)


# --- 图片 / 语音 -------------------------------------------------------------
# wxauto4 只认文字类消息:图片、语音在它那儿直接消失(raw 里连一条都没有)。
# 我们退回 UIA 自己去消息列表里找:
#   mmui::ChatImageItemView   图片
#   mmui::ChatVoiceItemView   语音,Name 形如 `语音2"秒未播放`
#   mmui::ChatBubbleReferItemView  表情包/贴图,Name 就是「动画表情」
# 每个条目都带 BoundingRectangle(物理像素,跟屏幕的 DPI 缩放一致),
# 图片就照这一块截图;语音点一下气泡下面的「转文字」,再把变出来的字读回来。
CAPTURE_DIR = os.path.join(os.environ.get("TEMP") or os.path.expanduser("~"), "wx4-captures")
MEDIA_HINTS = {"图片": "image", "表情": "sticker", "语音": "voice", "文件": "file"}
_MAIN = None


def media_kind(preview: str) -> str:
    """会话列表的预览行里,「[图片]」「[语音]」这类能看出是什么。"""
    t = preview or ""
    for word, kind in MEDIA_HINTS.items():
        if f"[{word}]" in t:
            return kind
    return ""


def _uia():
    import uiautomation as auto  # 延迟导入:出错也不至于让桥起不来

    return auto


def _main_window():
    global _MAIN
    auto = _uia()
    root = auto.GetRootControl()
    for w in root.GetChildren():
        try:
            if (w.ClassName or "") == "mmui::MainWindow":
                if w.BoundingRectangle.right > w.BoundingRectangle.left:
                    _MAIN = w
                    return w
        except Exception:  # noqa: BLE001
            continue
    return None


def _msg_list(win):
    stack = [win]
    guard = 0
    while stack and guard < 8000:
        guard += 1
        c = stack.pop()
        try:
            if "chat_message_list" in (c.AutomationId or ""):
                return c
            stack.extend(c.GetChildren())
        except Exception:  # noqa: BLE001
            continue
    return None


def _items(box) -> list:
    try:
        return list(box.GetChildren())
    except Exception:  # noqa: BLE001
        return []


def _class_of(c) -> str:
    try:
        return c.ClassName or ""
    except Exception:  # noqa: BLE001
        return ""


VOICE_NAME_RE = re.compile(r'^语音\s*(\d+)\s*["“”]?\s*秒\s*(?:未播放|已播放)?\s*(.*)$')


def voice_parts(name: str) -> tuple[str, str]:
    """`语音2"秒未播放` → ("2", "");转出文字后 Name 变成 `语音2"秒测试。` → ("2", "测试。")。"""
    raw = (name or "").strip()
    m = VOICE_NAME_RE.match(raw)
    if not m:
        return "", raw
    return m.group(1), m.group(2).strip().strip('"“”')


def _find_transcribe(item):
    """语音气泡下面的「转文字」小按钮。"""
    found = []

    def walk(c, depth=0):
        if depth > 8 or found:
            return
        try:
            if (c.Name or "").strip() in ("转文字", "转为文字"):
                found.append(c)
                return
            for k in c.GetChildren():
                walk(k, depth + 1)
        except Exception:  # noqa: BLE001
            return

    walk(item)
    return found[0] if found else None


def _grab(c, tag: str) -> str:
    """照这条消息的矩形截一张图,存 png,返回路径。"""
    try:
        from PIL import ImageGrab
    except Exception as err:  # noqa: BLE001
        log("没有 PIL,截不了图:", err)
        return ""
    r = c.BoundingRectangle
    l, t, rt, b = r.left, r.top, r.right, r.bottom
    if rt - l < 8 or b - t < 8:
        return ""
    os.makedirs(CAPTURE_DIR, exist_ok=True)
    path = os.path.join(CAPTURE_DIR, f"{tag}-{int(time.time() * 1000)}.png")
    try:
        img = ImageGrab.grab(bbox=(l, t, rt, b), all_screens=True)
        img.save(path)
    except Exception as err:  # noqa: BLE001
        log("截图失败:", err)
        return ""
    return path


def capture_media(chat: str, kind: str) -> dict:
    """打开 chat,把最后一条图片/语音拿到手;完了切回原来的会话。

    chat 传 "@" 表示「就用现在打开的这个会话」,不切也不切回 ——
    调试时先手动把会话滚到那条消息,再用它,免得每次都被拉回底部。
    """
    if not chat:
        return {}
    stay = chat == "@"
    out: dict = {}
    try:
        before = (wx.ChatInfo() or {}).get("chat_name") or ""
    except Exception:  # noqa: BLE001
        before = ""
    try:
        if not stay:
            wx.ChatWith(chat, exact=False)
            time.sleep(0.6)
        win = _main_window()
        box = _msg_list(win) if win else None
        if box is None:
            return {}
        want = {
            "voice": ("mmui::ChatVoiceItemView",),
            "image": ("mmui::ChatImageItemView",),
            "sticker": ("mmui::ChatBubbleReferItemView",),
        }.get(kind, ("mmui::ChatImageItemView", "mmui::ChatVoiceItemView"))
        target = None
        for it in _items(box):
            if _class_of(it) in want:
                target = it
        if target is None:
            return {}
        if kind == "voice" or _class_of(target) == "mmui::ChatVoiceItemView":
            seconds, text = voice_parts(target.Name)
            if seconds:
                out["voiceSeconds"] = seconds
            if not text:
                btn = _find_transcribe(target)
                if btn is not None:
                    try:
                        btn.Click(simulateMove=True)
                    except Exception:  # noqa: BLE001
                        try:
                            btn.GetInvokePattern().Invoke()
                        except Exception:  # noqa: BLE001
                            pass
                    # 转文字要等服务端,实测 3–6 秒;轮询到出来为止,最多 12 秒
                    for _ in range(24):
                        time.sleep(0.5)
                        fresh = None
                        for it in _items(box):
                            if _class_of(it) == "mmui::ChatVoiceItemView":
                                fresh = it
                        _, text = voice_parts(fresh.Name if fresh is not None else "")
                        if text:
                            break
            if text:
                out["voiceText"] = text
        path = _grab(target, kind)
        if path:
            out["imagePath"] = path
        log(f"capture {kind} -> {out}")
    except Exception as err:  # noqa: BLE001
        log("capture 失败:", err)
    finally:
        if (not stay) and before and before != chat:
            try:
                wx.ChatWith(before, exact=False)
            except Exception:  # noqa: BLE001
                pass
    return out


def op_capture(args: dict) -> dict:
    """手动试一把:{"chat":"阿黄","kind":"voice"}。"""
    return capture_media((args.get("chat") or "").strip(), (args.get("kind") or "image").strip())


OPS = {
    "ping": op_ping,
    "chats": op_chats,
    "read": op_read,
    "send": op_send,
    "capture": op_capture,
    "quit": op_quit,
}


# --- 轮询新消息 -------------------------------------------------------------
# 不做「独立监听窗口」(AddListenChat 会弹出一堆子窗口),直接比会话列表的
# 预览行:名字变了、内容变了、而且不是我刚发出去的那句 → 一条新消息。
_last: dict[str, tuple[str, str]] = {}
_sent_recent: dict[str, float] = {}
# 见过的消息文本 → 最后一次见到的时间。会话列表的预览会来回抖(未读数、「[1条]」
# 前缀、自己刚发的那句又被顶回来),只比上一轮不够,会把同一条推两遍、甚至把自己
# 发出去的话当成对方说的。文本按内容去重,10 分钟内不再报。
_seen: dict[str, float] = {}
SEEN_TTL = 180.0
_UNREAD_PREFIX = re.compile(r"^\[\d+条\]")


def _norm(text: str) -> str:
    """去掉空白与「[N条]」这类预览前缀,只比内容。"""
    t = _UNREAD_PREFIX.sub("", (text or "").strip())
    return re.sub(r"\s+", "", t)


def _is_own_echo(norm: str, now: float) -> bool:
    """预览里的这句是不是我刚发出去的(发送和预览常只差换行/截断/省略号)。"""
    for sent, at in list(_sent_recent.items()):
        if now - at > 60:
            continue
        sn = _norm(sent)
        if not sn or not norm:
            continue
        if sn == norm or sn in norm or norm in sn:
            return True
        # 预览会被截断成「……喵…」这种,取开头一段比
        head = min(10, len(sn), len(norm))
        if head >= 6 and sn[:head] == norm[:head]:
            return True
    return False


def poll_once() -> list:
    events = []
    for s in wx.GetSession():
        try:
            name = s.name
            preview = (getattr(s, "content", "") or "").strip()
            stamp = str(getattr(s, "time", "") or "")
        except Exception:  # noqa: BLE001
            continue
        if WATCH and not any(w in name for w in WATCH):
            continue
        key = (preview, stamp)
        old = _last.get(name)
        _last[name] = key
        # SEO: 按文本去重,见 _seen 的注释
        norm = _norm(preview)
        if not norm:
            continue
        now = time.time()
        hit = _seen.get(norm)
        if hit and now - hit < SEEN_TTL:
            continue
        if old is None or old == key:
            continue
        if _is_own_echo(norm, now):
            _seen[norm] = now
            continue  # 自己刚发的那句被会话预览顶回来,别回声
        _seen[norm] = now
        if len(_seen) > 500:
            for k in [k for k, t in _seen.items() if now - t > SEEN_TTL]:
                _seen.pop(k, None)
        kind = media_kind(preview)
        extra: dict = {}
        if kind and CAPTURE_MEDIA:
            # 图片/语音在预览行里只有一个「[图片]」,得回去把真东西抓出来。
            try:
                extra = capture_media(name, kind)
            except Exception as err:  # noqa: BLE001
                log("补图/补字失败:", err)
        events.append({
            "event": "message",
            "chat": name,
            "sender": name,
            "text": preview,
            "time": stamp,
            "kind": kind,
            **extra,
        })
    return events


# --- 主循环 -----------------------------------------------------------------

def feeder(q: "queue.Queue[str]") -> None:
    for line in sys.stdin:
        q.put(line)
    q.put("")


def main() -> None:
    feed: "queue.Queue[str]" = queue.Queue()
    threading.Thread(target=feeder, args=(feed,), daemon=True).start()

    try:
        connect()
        emit({"event": "state", "state": "ready", "me": _me})
    except Exception as err:  # noqa: BLE001
        emit({"event": "state", "state": f"error: {err}"})
        log("连不上微信:", err)
        return

    # 先把现状记下来,免得一启动就把历史当新消息全推一遍
    try:
        poll_once()
    except Exception as err:  # noqa: BLE001
        log("初始轮询失败:", err)

    last_poll = time.time()
    while True:
        handled = False
        try:
            line = feed.get(timeout=0.25)
        except queue.Empty:
            line = None
        if line is not None:
            if line == "":
                break  # stdin 关了
            raw = line.strip()
            if raw:
                handled = True
                try:
                    req = json.loads(raw)
                    rid = req.get("id")
                    op = req.get("op")
                    fn = OPS.get(op)
                    if fn is None:
                        raise ValueError(f"不认识的 op: {op}")
                    result = fn(req)
                    emit({"id": rid, "ok": True, "result": result})
                except SystemExit:
                    raise
                except Exception as err:  # noqa: BLE001
                    emit({"id": req_id(raw), "ok": False, "error": str(err)})
        if time.time() - last_poll >= POLL_SECONDS:
            last_poll = time.time()
            try:
                for event in poll_once():
                    emit(event)
            except Exception as err:  # noqa: BLE001
                log("轮询失败:", err)


def req_id(raw: str):
    try:
        return json.loads(raw).get("id")
    except Exception:  # noqa: BLE001
        return None


if __name__ == "__main__":
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    # 调试用:第一个参数是请求文件时直接从文件读,绕开 PowerShell 管道的编码坑。
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        with open(sys.argv[1], "r", encoding="utf-8-sig") as f:
            sys.stdin = io.StringIO(f.read())
    main()
