/**
 * WeChat World:通过 python 桥(UI Automation)接新版微信 4.x。
 * 收到的新消息以事件上报;发消息必须先起草、再由操作者确认,和 QQ 世界同一道门。
 */
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { BlobInput, ToolDef, ToolOutcome, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { WechatBridge, type BridgeEvent } from './bridge.ts';
import { splitList, WECHAT_CONFIG_GROUP, type WechatConfigSection } from './config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 默认走 wxauto4 那座桥;老的截屏 OCR 版还留着当备胎(bridge/wx_ocr_bridge.py)。 */
const BRIDGE_FILE = fileURLToPath(new URL('../bridge/wx4_bridge.py', import.meta.url));

export interface WechatWorldOptions {
  /** `worlds.wechat` 的活引用。 */
  cfg: WechatConfigSection;
  timezone: string;
  /** 桥脚本的缺省路径,配置没写时用它。 */
  bridgeScript?: string;
  /** 测试用:换掉真实的桥。 */
  bridgeFactory?: (opts: {
    python: string;
    script: string;
    pollSeconds?: number;
    onEvent: (event: BridgeEvent) => void;
    onState: (state: string) => void;
    log: WorldHost['log'];
  }) => WechatBridge;
}

interface Draft {
  chat: string;
  text: string;
}

/** 全部工具的声明;定义里的 describe 与 `tools()` 都取它。 */
export const WECHAT_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'wx_chats',
    description: 'List recent WeChat conversations with their unread counts.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many conversations to list.' },
      },
      required: [],
    },
  },
  {
    name: 'wx_read',
    description: 'Read the most recent messages of one WeChat conversation.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: { type: 'string', description: 'Conversation name as shown in WeChat.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many messages to read.' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'wx_draft',
    description: 'Stage a WeChat message without sending it. wx_confirm sends or discards it.',
    tags: ['speak'],
    barrierAfter: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: { type: 'string', description: 'Conversation name as shown in WeChat.' },
        text: { type: 'string', description: 'Message text to stage.' },
      },
      required: ['chat', 'text'],
    },
  },
  {
    name: 'wx_confirm',
    description: 'Send or discard the message staged by wx_draft. Sending is final.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decision: { type: 'string', enum: ['send', 'cancel'], description: 'send or cancel' },
      },
      required: ['decision'],
    },
  },
];

export class WechatWorld implements World {
  readonly id = 'wechat';
  private bridge: WechatBridge | null = null;
  private host: WorldHost | null = null;
  private draft: Draft | null = null;

  constructor(private readonly opts: WechatWorldOptions) {}

  envPromptVars(): Record<string, string> {
    const bridge = this.bridge?.running ? '在跑' : '没在跑';
    const draft = this.draft ? `${this.draft.chat}:${this.draft.text.slice(0, 40)}` : '没有';
    return { 'wechat.bridge': bridge, 'wechat.draft': draft };
  }

  tools(): ToolDef[] {
    return WECHAT_TOOL_DECLS.map((decl) => ({ ...decl, handler: this.handlerFor(decl.name) }));
  }

  webUi(): WorldWebUiDecl {
    return {
      config: [WECHAT_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.wechat.envPrompt',
          title: 'WeChat · 环境提示词',
          description: 'WeChat World 进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'wechat.bridge', description: '桥进程此刻在不在跑。' },
            { name: 'wechat.draft', description: '此刻待确认的草稿,没有就是「没有」。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    const script = this.opts.cfg.bridgeScript?.trim() || this.opts.bridgeScript || BRIDGE_FILE;
    const factory = this.opts.bridgeFactory ?? ((o) => new WechatBridge(o));
    this.bridge = factory({
      python: this.opts.cfg.python?.trim() || 'python',
      script,
      pollSeconds: Number(this.opts.cfg.pollSeconds) || 3,
      onEvent: (event) => void this.onBridgeEvent(event),
      onState: (state) => void this.onBridgeState(state),
      log: host.log,
    });
    try {
      this.bridge.start();
    } catch (err) {
      host.log.warn(`微信桥启动失败:${err instanceof Error ? err.message : String(err)}`);
    }
    await host.pushEvent({
      type: 'wechat.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `WeChat World 已挂载,桥脚本 ${script}。`,
    });
  }

  async stop(): Promise<void> {
    this.bridge?.stop();
    this.bridge = null;
    this.draft = null;
    this.host = null;
  }

  private handlerFor(name: string): ToolDef['handler'] {
    return async (args) => {
      switch (name) {
        case 'wx_chats':
          return this.listChats(Number(args.limit ?? 20));
        case 'wx_read':
          return this.readChat(String(args.chat ?? ''), Number(args.limit ?? 20));
        case 'wx_draft':
          return this.stageDraft(String(args.chat ?? ''), String(args.text ?? ''));
        case 'wx_confirm':
          return this.confirmDraft(String(args.decision ?? ''));
        default:
          return { text: `未知工具:${name}`, failed: true };
      }
    };
  }

  private async listChats(limit: number): Promise<string> {
    const rows = await this.callBridge<Array<{ name?: string; unread?: number }>>('chats', { limit });
    if (!Array.isArray(rows) || rows.length === 0) return '微信里没读到会话。';
    return rows
      .map((row, i) => `${i + 1}. ${row.name ?? '(无名)'}${row.unread ? ` [未读 ${row.unread}]` : ''}`)
      .join('\n');
  }

  private async readChat(chat: string, limit: number): Promise<string | ToolOutcome> {
    if (!chat.trim()) return { text: '要给一个会话名。', failed: true };
    const rows = await this.callBridge<Array<{ sender?: string; text?: string; time?: string }>>('read', {
      chat,
      limit,
    });
    if (!Array.isArray(rows) || rows.length === 0) return `「${chat}」没有读到消息。`;
    return rows.map((m) => `${m.time ? `[${m.time}] ` : ''}${m.sender ?? '?'}: ${m.text ?? ''}`).join('\n');
  }

  private async stageDraft(chat: string, text: string): Promise<string | ToolOutcome> {
    if (!chat.trim()) return { text: '要给一个会话名。', failed: true };
    if (!text.trim()) return { text: '草稿是空的。', failed: true };
    this.draft = { chat, text };
    return `草稿已就绪 → 「${chat}」:${text}\n要发就调 wx_confirm(decision="send"),不发就 cancel。`;
  }

  private async confirmDraft(decision: string): Promise<string | ToolOutcome> {
    const draft = this.draft;
    if (!draft) return { text: '没有待确认的草稿。', failed: true };
    if (decision !== 'send' && decision !== 'cancel') {
      return { text: 'decision 只能是 send 或 cancel。', failed: true };
    }
    this.draft = null;
    if (decision === 'cancel') return `已丢弃草稿(「${draft.chat}」那条)。`;
    const result = await this.callBridge<{ sent?: boolean }>('send', { chat: draft.chat, text: draft.text });
    return result?.sent === false
      ? { text: `没发出去:「${draft.chat}」那条还在草稿状态。`, failed: true }
      : `已发送 → 「${draft.chat}」:${draft.text}`;
  }

  private async callBridge<T>(op: string, args: Record<string, unknown>): Promise<T> {
    if (!this.bridge?.running) throw new Error('微信桥没在跑,先确认扩展已启用、python 能起来');
    return this.bridge.request<T>(op, args);
  }

  private async onBridgeState(state: string): Promise<void> {
    if (!this.host) return;
    if (state === 'ready' || state === 'connecting') return;
    await this.host.pushEvent({
      type: 'wechat.bridge',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `微信桥${state}。`,
    });
  }

  private async onBridgeEvent(event: BridgeEvent): Promise<void> {
    if (!this.host) return;
    if (event.event !== 'message') return;
    const chat = String(event.chat ?? '');
    const sender = String(event.sender ?? chat);
    const text = String(event.text ?? '');
    if (!chat || !text) return;
    const watch = splitList(this.opts.cfg.watchChats ?? '');
    const ignore = splitList(this.opts.cfg.ignoreChats ?? '');
    if (ignore.includes(chat)) return;
    if (watch.length > 0 && !watch.includes(chat)) return;

    const kind = String(event.kind ?? '');
    const voiceText = String(event.voiceText ?? '');
    const imagePath = String(event.imagePath ?? '');

    // 图片/语音在桥那边只有一个「[图片]」「[语音]」;真东西得挂成附件才看得见。
    const blobs: BlobInput[] = [];
    if (imagePath) {
      try {
        const bytes = await readFile(imagePath);
        blobs.push({
          bytes: new Uint8Array(bytes),
          mime: 'image/png',
          name: basename(imagePath),
          fallbackText: `[微信 · ${chat}] ${sender} 发来的${kind === 'voice' ? '语音气泡' : '图片'}`,
        });
      } catch (err) {
        this.host.log.warn(`微信附件读不出来(${imagePath}):${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const body = voiceText ? `${text}\n（转文字:${voiceText}）` : text;
    await this.host.pushEvent({
      type: 'wechat.message',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'external',
      senderKey: sender,
      text: `[微信 · ${chat}] ${sender}:${body}`,
      ...(blobs.length > 0 ? { blobs } : {}),
      meta: { chat, sender, wechatText: text, kind, voiceText },
    });
  }
}
