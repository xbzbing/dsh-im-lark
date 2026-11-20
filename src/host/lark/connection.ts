/**
 * 长连接：把官方 SDK 的 `WSClient` 包成一个有状态、可测试的端口。
 *
 * 三件事在这个文件里说清楚：
 *
 * 1. **不重写握手**。鉴权、心跳、重连都交给 SDK；我们只订阅它暴露的状态回调
 *    与 `getConnectionStatus()`，把状态收敛成插件自己的取值。
 * 2. **活性交给 SDK**。心跳与假活由 SDK 的 `pingTimeout` 看门狗处理；本层不靠
 *    「多久没收到业务事件」猜断线（空闲机器人本来就没有事件），只如实合并状态。
 * 3. **事件只入队**。平台要求 3 秒内处理完事件，超时会重推；这里 handler 只做
 *    形状校验与入队，重活（下载媒体、交核心）由运行期异步做。
 */

import type { LarkCredentials } from './types.ts';

export interface LarkLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
  error?(...args: unknown[]): unknown;
  debug?(...args: unknown[]): unknown;
}

/** SDK 认的 logger 形状：五个级别都要有。 */
export interface SdkLoggerLike {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
}

/**
 * 把 SDK 的 logger 接到插件日志上。
 *
 * SDK 的 `LoggerProxy` 会把参数先收成**数组**再调用（`logger.info(['[ws]', ...])`），
 * 直接透传会把整个数组当成一条消息，所以这里摊平一层。不显式传 logger 时 SDK 用
 * 自带的 console 实现（`[ws] reconnect` 这类会直接打到宿主 stdout），因此必须接过来。
 */
export function sdkLogger(target: LarkLogger | undefined): SdkLoggerLike {
  const forward = (level: 'info' | 'warn' | 'error' | 'debug') => (...args: unknown[]) => {
    const sink = target?.[level] as ((...values: unknown[]) => unknown) | undefined;
    if (typeof sink !== 'function') return;
    const values = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    sink.apply(target, values);
  };
  return {
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
    debug: forward('debug'),
    // SDK 的级别是 info，trace 实际不会触发；真触发时按 debug 记。
    trace: forward('debug'),
  };
}

export type LarkConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface LarkConnectionStatus {
  state: LarkConnectionState;
  /** 进入当前状态的时刻（毫秒）。 */
  since: number;
  /** 最近一次错误的一句话描述（已脱敏）。 */
  lastError?: string;
  reconnectAttempts: number;
  /** 最近一次收到平台帧的时刻；活性检测用。 */
  lastFrameAt?: number;
}

/** 连接把事件交给谁。两个回调都必须立即返回，不能 await 重活。 */
export interface LarkConnectionHandlers {
  /** `im.message.receive_v1` 的原始事件体。 */
  onMessage(envelope: unknown): void;
  /** `card.action.trigger` 的原始回调体。 */
  onCardAction(envelope: unknown): void;
}

/** 事件名：与开发者后台「事件与回调」里的配置逐字一致。 */
export const EVENT_MESSAGE_RECEIVE = 'im.message.receive_v1';
export const EVENT_CARD_ACTION = 'card.action.trigger';

/** WSClient 的公开子集。 */
export interface WsClientLike {
  start(params: { eventDispatcher: unknown }): Promise<void>;
  close(params?: { force?: boolean }): void;
  getConnectionStatus?(): { state?: string; reconnectAttempts?: number };
}

/** EventDispatcher 的公开子集。 */
export interface EventDispatcherLike {
  register(handles: Record<string, (data: unknown) => unknown>): EventDispatcherLike;
}

export interface LarkConnectionOptions {
  /** 应用身份：长连接握手要用的全部信息。 */
  app: LarkCredentials;
  logger?: LarkLogger;
  /** 建 WSClient / EventDispatcher 的工厂；测试注入假实现。 */
  createWsClient(params: Record<string, unknown>): WsClientLike;
  createDispatcher(params: Record<string, unknown>): EventDispatcherLike;
  /** 握手超时（毫秒）。默认 20 秒。 */
  handshakeTimeoutMs?: number;
  /** SDK 活性看门狗窗口（秒）。SDK 的 ping 间隔是 120 秒。 */
  pingTimeoutSec?: number;
  /** 状态变化通知（面板与运行期都用它）。 */
  onStatus?(status: LarkConnectionStatus): void;
  /** 当前时刻；测试注入。 */
  now?(): number;
}

/**
 * 长连接端口。
 *
 * `stop()` 是同步的：SDK 的 `close()` 不返回 Promise，关连接不该让调用方等。
 */
export interface LarkConnectionPort {
  start(handlers: LarkConnectionHandlers): Promise<void>;
  stop(): void;
  status(): LarkConnectionStatus;
}

/** SDK 的握手可能在没有任何回调的情况下挂住，这里给一个上限。 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;

/** SDK 的 pong 超时窗口（秒）：45 秒没有心跳响应就判死，与业务事件无关。 */
const DEFAULT_PING_TIMEOUT_SEC = 45;

/** 握手等待的轮询间隔。 */
const HANDSHAKE_POLL_MS = 100;

export class LarkConnection implements LarkConnectionPort {
  readonly #options: LarkConnectionOptions;
  readonly #now: () => number;
  #client: WsClientLike | null = null;
  #status: LarkConnectionStatus;
  /** `stop()` 之后到达的回调一律忽略，避免「关掉又活过来」。 */
  #stopped = false;
  /** 每次 start 递增：旧连接的回调认不出新代次就不生效。 */
  #generation = 0;

  constructor(options: LarkConnectionOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#status = { state: 'idle', since: this.#now(), reconnectAttempts: 0 };
  }

  status(): LarkConnectionStatus {
    return this.#withLiveState();
  }

  async start(handlers: LarkConnectionHandlers): Promise<void> {
    this.#stopped = false;
    this.#generation += 1;
    const generation = this.#generation;
    const isCurrent = () => !this.#stopped && this.#generation === generation;

    this.#closeClient(true);
    this.#setStatus({ state: 'connecting', reconnectAttempts: 0 }, '开始连接');

    const dispatcher = this.#options
      .createDispatcher({})
      .register({
        [EVENT_MESSAGE_RECEIVE]: (data: unknown) => {
          if (!isCurrent()) return;
          this.#noteFrame();
          try {
            handlers.onMessage(data);
          } catch (error) {
            this.#options.logger?.warn?.('处理消息事件失败', error);
          }
        },
        [EVENT_CARD_ACTION]: (data: unknown) => {
          if (!isCurrent()) return;
          this.#noteFrame();
          try {
            handlers.onCardAction(data);
          } catch (error) {
            this.#options.logger?.warn?.('处理卡片回调失败', error);
          }
        },
      });

    const client = this.#options.createWsClient({
      appId: this.#options.app.appId,
      appSecret: this.#options.app.appSecret,
      domain: this.#options.app.domain,
      loggerLevel: 'info',
      logger: sdkLogger(this.#options.logger),
      handshakeTimeoutMs: this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      wsConfig: { pingTimeout: this.#options.pingTimeoutSec ?? DEFAULT_PING_TIMEOUT_SEC },
      source: 'dsh-im-lark',
      onReady: () => {
        if (!isCurrent()) return;
        this.#setStatus({ state: 'connected', reconnectAttempts: 0, lastError: undefined }, '握手成功');
      },
      onReconnecting: () => {
        if (!isCurrent()) return;
        this.#setStatus(
          { state: 'reconnecting', reconnectAttempts: this.#status.reconnectAttempts + 1 },
          '连接断开，等待重连',
        );
      },
      onReconnected: () => {
        if (!isCurrent()) return;
        this.#setStatus({ state: 'connected', reconnectAttempts: 0, lastError: undefined }, '重连成功');
      },
      onError: (error: unknown) => {
        if (!isCurrent()) return;
        const message = (error as Error | undefined)?.message ?? String(error);
        // SDK 的 onError 表示「已经放弃重试」（初次连接失败且不再重试，或重试耗尽），
        // 所以这里直接落 failed，把要不要重来交给人或运行期的重启逻辑。
        this.#setStatus(
          {
            state: 'failed',
            lastError: message,
            reconnectAttempts: this.#status.reconnectAttempts + 1,
          },
          '连接失败',
        );
      },
    });
    this.#client = client;
    this.#noteFrame();

    await this.#awaitHandshake(client, dispatcher, isCurrent);
  }

  stop(): void {
    this.#stopped = true;
    this.#generation += 1;
    this.#closeClient(true);
    this.#setStatus({ state: 'idle', reconnectAttempts: 0, lastError: undefined }, '主动断开');
  }

  /**
   * 把 SDK 的实时状态并进来。
   *
   * 合并规则只为了避免「状态比事实更乐观」：
   * - 本地已经  就保持 failed，重启是显式动作，不让 SDK 把它冲掉；
   * - SDK 报断开类状态（reconnecting / failed）一律采纳；
   * - SDK 报 connected 而本地还停在 connecting 时采纳（回调可能丢了）。
   * 其余情况保留本地状态：SDK 在重连起点会短暂报 connecting，跟着它抖没有意义。
   */
  #withLiveState(): LarkConnectionStatus {
    const own = this.#status;
    const live = this.#client?.getConnectionStatus?.();
    if (!live || typeof live.state !== 'string') return { ...own };
    const mapped = mapSdkState(live.state);
    if (mapped === undefined) return { ...own };
    const attempts = live.reconnectAttempts ?? own.reconnectAttempts;
    if (own.state === 'failed') return { ...own, reconnectAttempts: attempts };
    if (mapped === own.state) return { ...own, reconnectAttempts: attempts };
    if (mapped === 'reconnecting' || mapped === 'failed') {
      return { ...own, state: mapped, since: this.#now(), reconnectAttempts: attempts };
    }
    if (mapped === 'connected' && own.state === 'connecting') {
      return { ...own, state: mapped, since: this.#now(), reconnectAttempts: attempts };
    }
    return { ...own, reconnectAttempts: attempts };
  }
  #noteFrame(): void {
    this.#status = { ...this.#status, lastFrameAt: this.#now() };
  }

  #setStatus(patch: Partial<LarkConnectionStatus>, reason: string): void {
    const changed = patch.state !== undefined && patch.state !== this.#status.state;
    const next: LarkConnectionStatus = {
      ...this.#status,
      ...patch,
      since: changed ? this.#now() : this.#status.since,
    };
    this.#status = next;
    this.#options.logger?.debug?.(`连接状态 → ${next.state}（${reason}）`);
    this.#options.onStatus?.({ ...next });
  }

  #closeClient(force: boolean): void {
    const client = this.#client;
    this.#client = null;
    if (!client) return;
    try {
      client.close({ force });
    } catch (error) {
      // 关闭失败不该影响后续流程：连接对象已在本地丢弃，SDK 内部会自行释放。
      this.#options.logger?.debug?.('关闭长连接时报错', error);
    }
  }

  /** 等握手：`start()` 可能一直不返回，`onReady` 才是权威信号。 */
  async #awaitHandshake(
    client: WsClientLike,
    dispatcher: EventDispatcherLike,
    isCurrent: () => boolean,
  ): Promise<void> {
    const timeoutMs = this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    // start() 不返回也不代表没连上（SDK 会一直挂着等重连），所以它既不是完成
    // 信号也不是超时信号：只把它的失败转成状态，交给轮询统一收口。
    void Promise.resolve(client.start({ eventDispatcher: dispatcher })).catch((error: unknown) => {
      this.#setStatus({ state: 'failed', lastError: (error as Error).message }, '启动失败');
    });

    const ready = new Promise<void>((resolve, reject) => {
      const poll = () => {
        if (settled) return;
        // onReady 回调可能丢失：以 SDK 的实时状态兜底，避免「实际已连上却判超时」。
        const state = this.#withLiveState().state;
        if (state === 'connected') {
          settled = true;
          resolve();
          return;
        }
        if (state === 'failed') {
          settled = true;
          reject(new Error(this.#status.lastError ?? '长连接建立失败'));
          return;
        }
        pollTimer = setTimeout(poll, HANDSHAKE_POLL_MS);
      };
      poll();
    });

    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`长连接握手超时（${timeoutMs}ms）`));
      }, timeoutMs);
      if (typeof timeoutTimer === 'object' && 'unref' in timeoutTimer) timeoutTimer.unref();
    });

    try {
      await Promise.race([ready, timeout]);
    } catch (error) {
      this.#setStatus(
        {
          state: 'failed',
          lastError: (error as Error).message,
          reconnectAttempts: this.#status.reconnectAttempts + 1,
        },
        '握手失败',
      );
      throw error;
    } finally {
      settled = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }

    if (!isCurrent()) throw new Error('连接已失效');
    // 状态回调丢了也要让本地状态与事实一致。
    if (this.#status.state !== 'connected') {
      this.#setStatus({ state: 'connected', lastError: undefined }, '握手完成（状态回调缺失）');
    }
  }
}

function mapSdkState(state: string): LarkConnectionState | undefined {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'reconnecting':
      return 'reconnecting';
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}
