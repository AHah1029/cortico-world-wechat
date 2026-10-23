import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { WECHAT_DEFAULTS, type WechatConfigSection } from './config.ts';
import { WECHAT_TOOL_DECLS, WechatWorld } from './world.ts';

export const WECHAT: WorldDefinition<WechatConfigSection> = {
  id: 'wechat',
  label: 'WeChat',
  defaults: () => ({ ...WECHAT_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.wechat` 的活引用:热改的键现读即生效。
  create: (ctx) => new WechatWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
  describe: {
    tools: describeTools(WECHAT_TOOL_DECLS, {
      wx_chats: { zh: '列出微信最近的会话和未读数。', en: 'Lists recent WeChat conversations with unread counts.' },
      wx_read: { zh: '读某个会话最近的消息。', en: 'Reads the latest messages of one conversation.' },
      wx_draft: { zh: '起草一条微信消息,先不发。', en: 'Stages a WeChat message without sending it.' },
      wx_confirm: { zh: '发送或丢弃刚才起草的那条。', en: 'Sends or discards the staged message.' },
    }),
    events: [
      { type: 'wechat.started', description: { zh: 'World 挂载完成。', en: 'The World was mounted.' } },
      { type: 'wechat.message', description: { zh: '微信收到一条新消息。', en: 'A new WeChat message arrived.' } },
      { type: 'wechat.bridge', description: { zh: '微信桥断开或出错。', en: 'The bridge went down or errored.' } },
    ],
  },
};
