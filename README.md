# cortico-world-wechat

Coopanion 的 Cortico World 扩展:把桌宠接到这台电脑上**开着的微信 4.x**。

- **收**:微信里来了新消息,以 `wechat.message` 事件进主 session。
- **读**:`wx_chats` 列会话,`wx_read` 读某个会话最近的消息。
- **发**:`wx_draft` 起草 → 操作者确认 → `wx_confirm(decision="send")` 才真的发出去。
  和 QQ 世界同一道门:自己起草的东西一句都不能擅自发。

## 怎么实现的

微信 4.x 没有可用的协议端,也不适合注入,所以走 **UI Automation**:
`bridge/wx4_bridge.py` 起一个 python 子进程,用 `wxauto4`(支持微信 4.1 的那一支)读窗口、
点输入框、发消息;`src/bridge.ts` 用 JSON 行协议和它说话,`src/world.ts` 把它包成 World。

```
Coopanion ── src/world.ts ── src/bridge.ts ──stdio── wx4_bridge.py ── UIA ── 微信 4.1
```

## 装

1. 电脑上装 python(3.10+)并装依赖:`pip install wxauto4 uiautomation`
2. 打开发微信 4.x 4.1.15.x,登录好,别最小化到托盘(最小化时读不到)。
3. Coopanion 的扩展页里「从本机目录安装」,选这个文件夹。
4. 启用后到「World: WeChat」页确认 python 路径;`worlds.wechat.watchChats` 可以先写上要收的会话名。

## 配置

| 键 | 说明 |
|---|---|
| `worlds.wechat.enabled` | 是否挂载 |
| `worlds.wechat.python` | python 可执行文件,默认 `python` |
| `worlds.wechat.bridgeScript` | 桥脚本路径,留空用包内 `bridge/wx4_bridge.py` |
| `worlds.wechat.pollSeconds` | 轮询新消息的间隔 |
| `worlds.wechat.watchChats` | 只收这些会话(逗号分隔,空=都收) |
| `worlds.wechat.ignoreChats` | 不收这些会话 |

## 已知边界

- 电脑锁屏、微信被关掉或多开窗口错乱时,桥会报错而不是装作成功。
- 微信没有历史回溯接口,`wx_read` 只能读客户端窗口里现成的那些。
- 微信 3.9 已经被官方挡在登录页(「版本过低」),这个扩展只对 4.x 有效。

## 开发

```bash
corepack pnpm install
pnpm test
pnpm typecheck
```
