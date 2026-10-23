import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld } from 'cortico/extensions/dry-mount.ts';
import { WECHAT } from '../src/definition.ts';
import { WechatWorld } from '../src/world.ts';
import { WECHAT_DEFAULTS } from '../src/config.ts';
import type { WechatBridge } from '../src/bridge.ts';
import { FakeHost } from './helpers/fake-host.ts';

class FakeBridge {
  running = false;
  sent: Array<{ chat: string; text: string }> = [];
  start(): void {
    this.running = true;
  }
  stop(): void {
    this.running = false;
  }
  async request(op: string, args: Record<string, unknown>): Promise<unknown> {
    if (op === 'send') {
      this.sent.push({ chat: String(args.chat), text: String(args.text) });
      return { sent: true };
    }
    if (op === 'chats') return [{ name: '阿黄', unread: 2 }];
    if (op === 'read') return [{ sender: '阿黄', text: '在吗', time: '16:00' }];
    throw new Error(`未知 op ${op}`);
  }
}

let scratchDir: string;
let bridge: FakeBridge;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'wechat-world-'));
  bridge = new FakeBridge();
});
afterEach(() => rmSync(scratchDir, { recursive: true, force: true }));

function makeWorld() {
  const world = new WechatWorld({
    cfg: { ...WECHAT_DEFAULTS },
    timezone: 'Asia/Shanghai',
    bridgeFactory: () => bridge as unknown as WechatBridge,
  });
  const host = new FakeHost();
  return { world, host };
}

describe('WeChat World', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    const report = await dryMountWorld(WECHAT, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('挂载时投一条 wechat.started 事件,origin 是 internal', async () => {
    const { world, host } = makeWorld();
    await world.start(host);
    expect(host.events.map((e) => e.type)).toEqual(['wechat.started']);
    expect(host.events[0].origin).toBe('internal');
    expect(bridge.running).toBe(true);
    await world.stop();
    expect(bridge.running).toBe(false);
  });

  it('wx_chats 与 wx_read 走桥并把结果摊成文本', async () => {
    const { world, host } = makeWorld();
    await world.start(host);
    const tools = Object.fromEntries(world.tools().map((t) => [t.name, t]));
    const call = {} as ToolCallContext;
    expect(await tools.wx_chats.handler({ limit: 10 }, call)).toContain('阿黄');
    expect(await tools.wx_read.handler({ chat: '阿黄', limit: 10 }, call)).toContain('在吗');
    await world.stop();
  });

  it('发消息必须先起草;取消就不发,发送才真的发', async () => {
    const { world, host } = makeWorld();
    await world.start(host);
    const tools = Object.fromEntries(world.tools().map((t) => [t.name, t]));
    const call = {} as ToolCallContext;

    expect(await tools.wx_confirm.handler({ decision: 'send' }, call)).toMatchObject({ failed: true });

    await tools.wx_draft.handler({ chat: '阿黄', text: '在的' }, call);
    await tools.wx_confirm.handler({ decision: 'cancel' }, call);
    expect(bridge.sent).toEqual([]);

    await tools.wx_draft.handler({ chat: '阿黄', text: '在的' }, call);
    const sent = await tools.wx_confirm.handler({ decision: 'send' }, call);
    expect(bridge.sent).toEqual([{ chat: '阿黄', text: '在的' }]);
    expect(String(sent)).toContain('已发送');
    await world.stop();
  });
});
