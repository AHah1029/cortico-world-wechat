import type { ConfigGroup } from 'cortico/core/types.ts';

/** config.json 的 worlds.wechat 段,默认禁用;要接微信时在 WebUI 打开。 */
export interface WechatConfigSection {
  enabled: boolean;
  /** python 可执行文件。 */
  python: string;
  /** 桥脚本路径;留空用扩展包里的 bridge/wx4_bridge.py。 */
  bridgeScript: string;
  /** 轮询新消息的间隔(秒)。 */
  pollSeconds: number;
  /** 只报告这些会话的新消息,逗号分隔;留空 = 全部(受 ignoreChats 影响)。 */
  watchChats: string;
  /** 不报告的会话,逗号分隔。 */
  ignoreChats: string;
}

export const WECHAT_DEFAULTS: WechatConfigSection = {
  enabled: false,
  python: 'python',
  bridgeScript: '',
  pollSeconds: 3,
  watchChats: '',
  ignoreChats: '',
};

/** World 配置的 JSON Schema 声明。 */
export const WECHAT_CONFIG_GROUP: ConfigGroup = {
  id: 'world:wechat',
  owner: 'world:wechat',
  schema: {
    type: 'object',
    title: 'WeChat',
    properties: {
      'worlds.wechat.python': {
        type: 'string',
        title: 'python 路径',
        description: '跑桥脚本用的 python,默认 `python`。',
      },
      'worlds.wechat.bridgeScript': {
        type: 'string',
        title: '桥脚本路径',
        description: '留空则用扩展包内的 bridge/wx4_bridge.py。',
      },
      'worlds.wechat.pollSeconds': {
        type: 'number',
        title: '轮询间隔(秒)',
        description: '多久看一次新消息。',
        'x-hot': true,
      },
      'worlds.wechat.watchChats': {
        type: 'string',
        title: '只收这些会话',
        description: '会话名,逗号分隔;留空表示都收。',
        'x-hot': true,
      },
      'worlds.wechat.ignoreChats': {
        type: 'string',
        title: '忽略这些会话',
        description: '会话名,逗号分隔。',
        'x-hot': true,
      },
    },
  },
};

/** 逗号(中英文都收)分隔的名单。 */
export function splitList(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
