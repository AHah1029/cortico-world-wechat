/** 和 python 桥进程之间的 JSON 行协议:一请求一响应,外加异步事件。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface BridgeEvent {
  event: string;
  [key: string]: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeOptions {
  /** python 可执行文件,默认 `python`。 */
  python: string;
  /** 桥脚本的绝对路径。 */
  script: string;
  /** 单条请求的默认超时。 */
  timeoutMs?: number;
  /** 桥自己轮询新消息的间隔(秒),默认 3。 */
  pollSeconds?: number;
  /** 额外给桥进程的环境变量。 */
  env?: Record<string, string>;
  onEvent: (event: BridgeEvent) => void;
  /** `connecting` / `ready` / `disconnected` / `error: …`。 */
  onState: (state: string) => void;
  log: { info(msg: string): void; warn(msg: string): void };
}

/** 桥进程的薄客户端;进程挂了以后所有在途请求立刻失败,不假装成功。 */
export class WechatBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private closed = true;

  constructor(private readonly opts: BridgeOptions) {}

  get running(): boolean {
    return !this.closed;
  }

  start(): void {
    if (!this.closed) return;
    this.closed = false;
    this.opts.onState('connecting');
    const proc = spawn(this.opts.python, ['-u', this.opts.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        WX_POLL_SECONDS: String(this.opts.pollSeconds ?? 3),
        ...(this.opts.env ?? {}),
      },
    });
    this.proc = proc;
    this.lines = createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.lines.on('line', (line) => this.handleLine(line));
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.opts.log.warn(`[wx bridge stderr] ${text.slice(0, 500)}`);
    });
    proc.on('exit', (code) => {
      const wasClosed = this.closed;
      this.closed = true;
      this.lines?.close();
      this.lines = null;
      this.proc = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('微信桥进程已退出'));
        this.pending.delete(id);
      }
      if (!wasClosed) this.opts.onState(`disconnected (exit ${code ?? '?'})`);
    });
  }

  stop(): void {
    this.closed = true;
    try {
      this.proc?.stdin.write(JSON.stringify({ id: 0, op: 'quit' }) + '\n');
    } catch {
      // 进程已经没了,忽略
    }
    this.proc?.kill();
    this.proc = null;
    this.lines?.close();
    this.lines = null;
  }

  request<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.proc || this.closed) return Promise.reject(new Error('微信桥没在跑'));
    const id = ++this.seq;
    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`微信桥请求超时:${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.proc!.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.opts.log.warn(`[wx bridge] 无法解析的一行:${text.slice(0, 200)}`);
      return;
    }
    if (typeof msg.event === 'string') {
      if (msg.event === 'ready' || (msg.event === 'state' && msg.state === 'ready')) {
        this.opts.onState('ready');
      }
      this.opts.onEvent(msg as BridgeEvent);
      return;
    }
    const id = typeof msg.id === 'number' ? msg.id : -1;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (msg.ok === true) pending.resolve(msg.result);
    else pending.reject(new Error(typeof msg.error === 'string' ? msg.error : '微信桥返回失败'));
  }
}
