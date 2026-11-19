/**
 * 运行期：把凭据、设置、长连接与（后续的）入站流水线串起来。
 *
 * 生命周期只有两条路径：**有凭据且启用** → 建连接；**没有凭据或停用** → 停在
 * 「未连接」，等面板配置。启停都走同一套 `#connect` / `#disconnect`，避免出现
 * 半连接状态。
 *
 * 本文件只留生命周期与状态；事件怎么变成草稿在 `inbound.ts`，怎么变成消息在
 * `outbound.ts`（AGENTS.md 的文件规模规则）。
 */

import type { LarkConnectionHandlers, LarkConnectionPort, LarkConnectionStatus } from './lark/connection.ts';
import type { LarkLogger } from './lark/connection.ts';
import type { LarkCredentials, LarkDomain } from './lark/types.ts';
import type { NormalizedConfig, LocalConfigStore, LocalSettings } from './config.ts';
import type { CredentialStore } from './state/credentials.ts';

/** 事件去向：入站流水线实现它。 */
export interface LarkEventSink {
  onMessage(envelope: unknown): void;
  onCardAction(envelope: unknown): void;
}

export interface RuntimeChange {
  /** 当前凭据；没有配置为 null。 */
  app: LarkCredentials | null;
}

export interface RuntimeDeps {
  config: NormalizedConfig;
  logger: LarkLogger;
  credentials: CredentialStore;
  settings: LocalConfigStore;
  /** 建连接；凭据换了要重建，所以是工厂而不是实例。 */
  createConnection(app: LarkCredentials): LarkConnectionPort;
  /** 事件去向；未装配时事件被丢弃并记一条日志。 */
  sink?: LarkEventSink;
  /** 凭据变化（启动、面板保存、清除）：入口据此重建整套对象。 */
  onChange?: (change: RuntimeChange) => void;
  /** 设置变化（启动、面板保存）：入口据此决定接核心还是走独立模式。 */
  onSettings?: (settings: LocalSettings) => void;
  /** 初次启动失败后的重试基数（毫秒），默认 5000；测试可调小。 */
  retryBaseMs?: number;
  /** 假活看门狗周期（毫秒），默认 60000；0 表示关闭，测试可调小。 */
  watchdogMs?: number;
}

/** 面板读的状态快照：只放能安全展示的字段。 */
export interface RuntimeStatus {
  /** 已配置的 App ID 尾号；未配置为 null。 */
  appIdTail: string | null;
  domain: LarkDomain;
  /** 面板开关：是否接入飞书。 */
  enabled: boolean;
  /** 面板开关：是否接入我的超级助理。 */
  superagent: boolean;
  connection: LarkConnectionStatus;
  /** 是否有消费方（核心服务在且开关开着）。 */
  coreAvailable: boolean;
  lastError?: string;
}

export class LarkRuntime {
  readonly #deps: RuntimeDeps;
  #connection: LarkConnectionPort | null = null;
  #settings: LocalSettings | null = null;
  #credentials: LarkCredentials | null = null;
  #sink: LarkEventSink | undefined;
  #stopped = true;
  #lastError: string | undefined;
  #coreAvailable = false;
  /** 初次连接失败后的自愈定时器（指数退避，最长 60 秒）。 */
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryAttempt = 0;
  /** 假活检测：状态连着但长期没有帧时主动重建。 */
  #watchdogTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.#sink = deps.sink;
  }

  /** 装配后调用一次：读设置与凭据，决定要不要连。 */
  async start(): Promise<void> {
    this.#stopped = false;
    this.#settings = await this.#deps.settings.load();
    this.#deps.onSettings?.(this.#settings);
    this.#credentials = await this.#deps.credentials.load();
    this.#deps.onChange?.({ app: this.#credentials });
    if (this.#shouldConnect()) {
      await this.#connect();
    }
    this.#startWatchdog();
  }

  /** 停用 / 卸载：断开连接，不再接受事件。 */
  stop(): void {
    this.#stopped = true;
    this.#disconnect();
    this.#stopWatchdog();
    this.#deps.onChange?.({ app: null });
  }

  /** 插件当前是否在收消息：启用 && 有凭据 && 未停机。 */
  get active(): boolean {
    return !this.#stopped && this.#shouldConnect();
  }

  /** 事件去向可以在装配后被替换（面板重载、核心上线）。 */
  setSink(sink: LarkEventSink | undefined): void {
    this.#sink = sink;
  }

  /** 核心服务是否可用：面板据此决定「接入我的超级助理」能不能打开。 */
  setCoreAvailable(available: boolean): void {
    this.#coreAvailable = available;
  }

  get coreAvailable(): boolean {
    return this.#coreAvailable;
  }

  /** 面板改了设置：落盘并重判要不要连。 */
  async applySettings(patch: Partial<LocalSettings>): Promise<LocalSettings> {
    const saved = await this.#deps.settings.save(patch);
    this.#settings = saved;
    this.#deps.onSettings?.(saved);
    await this.#reconcile();
    return saved;
  }

  /** 面板保存了凭据：换连接。 */
  async reloadCredentials(): Promise<void> {
    const previous = this.#credentials;
    this.#credentials = await this.#deps.credentials.load();
    if (sameCredentials(previous, this.#credentials)) return;
    // 连接是按旧凭据建的，必须重建；只走 #reconcile 会因为「已有连接」而什么都不做。
    this.#disconnect();
    this.#deps.onChange?.({ app: this.#credentials });
    await this.#reconcile();
  }

  /** 状态快照。 */
  status(): RuntimeStatus {
    const connection = this.#connection?.status() ?? { state: 'idle' as const, since: Date.now(), reconnectAttempts: 0 };
    return {
      appIdTail: this.#credentials === null ? null : tailOf(this.#credentials.appId),
      domain: this.#credentials?.domain ?? this.#deps.config.domain,
      enabled: this.#settings?.enabled ?? this.#deps.config.enabled,
      superagent: this.#settings?.superagent ?? this.#deps.config.superagent,
      connection,
      coreAvailable: this.#coreAvailable,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    };
  }

  /** 手动重连：面板上的「重新连接」。 */
  async reconnect(): Promise<void> {
    if (!this.#shouldConnect()) {
      await this.#reconcile();
      return;
    }
    this.#disconnect();
    await this.#connect();
  }

  async #reconcile(): Promise<void> {
    if (this.#stopped) return;
    if (this.#shouldConnect()) {
      if (this.#connection === null) await this.#connect();
      return;
    }
    this.#disconnect();
  }

  #shouldConnect(): boolean {
    return this.#credentials !== null && (this.#settings?.enabled ?? this.#deps.config.enabled);
  }

  async #connect(): Promise<void> {
    const app = this.#credentials;
    if (app === null) return;
    const connection = this.#deps.createConnection(app);
    this.#connection = connection;

    const handlers: LarkConnectionHandlers = {
      onMessage: (envelope) => this.#sink?.onMessage(envelope),
      onCardAction: (envelope) => this.#sink?.onCardAction(envelope),
    };

    try {
      await connection.start(handlers);
      this.#lastError = undefined;
      this.#retryAttempt = 0;
      this.#cancelRetry();
    } catch (error) {
      this.#lastError = (error as Error).message;
      this.#deps.logger.warn?.('长连接启动失败', this.#lastError);
      this.#scheduleRetry();
    }
  }

  #retryDelay(): number {
    const base = this.#deps.retryBaseMs ?? 5_000;
    return Math.min(60_000, base * 2 ** Math.min(this.#retryAttempt, 4));
  }

  #scheduleRetry(): void {
    this.#cancelRetry();
    if (this.#stopped || !this.#shouldConnect()) return;
    const delay = this.#retryDelay();
    this.#retryAttempt += 1;
    this.#deps.logger.debug?.(`长连接将在 ${delay}ms 后重试`);
    const timer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#retryConnect();
    }, delay);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.#retryTimer = timer;
  }

  #cancelRetry(): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  async #retryConnect(): Promise<void> {
    if (this.#stopped || !this.#shouldConnect()) return;
    this.#disconnect();
    await this.#connect();
  }

  #disconnect(): void {
    this.#cancelRetry();
    const connection = this.#connection;
    this.#connection = null;
    connection?.stop();
  }

  #startWatchdog(): void {
    const interval = this.#deps.watchdogMs ?? 60_000;
    if (interval <= 0) return;
    this.#stopWatchdog();
    const timer = setInterval(() => {
      const connection = this.#connection;
      if (connection === null) return;
      // SDK 已经放弃重试：走运行期自己的退避重连，而不是等用户点面板。
      if (connection.status().state === 'failed') {
        this.#scheduleRetry();
        return;
      }
      if (connection.looksStalled?.() !== true) return;
      this.#deps.logger.warn?.('长连接长时间没有入站帧，主动重建');
      void connection.restart?.().catch((error: unknown) => {
        this.#deps.logger.warn?.('重建长连接失败', error instanceof Error ? error.message : String(error));
      });
    }, interval);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.#watchdogTimer = timer;
  }

  #stopWatchdog(): void {
    if (this.#watchdogTimer !== undefined) {
      clearInterval(this.#watchdogTimer);
      this.#watchdogTimer = undefined;
    }
  }
}

/** App ID 尾号：面板只显示它。 */
function tailOf(appId: string): string {
  return appId.length > 6 ? appId.slice(-6) : appId;
}

function sameCredentials(a: LarkCredentials | null, b: LarkCredentials | null): boolean {
  if (a === null || b === null) return a === b;
  return a.appId === b.appId && a.domain === b.domain && a.appSecret === b.appSecret;
}
