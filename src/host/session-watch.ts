/**
 * `/send` 与 `/queue` 的回答观察者：盯住目标会话的这一轮，结束后把回答发回飞书。
 *
 * 事件来自宿主的 `session/event`（一个监听器覆盖所有会话，不为每个会话单独订阅）。
 * 回调里只做状态折叠（同步、不抛），发送放进按会话串行的队列：同一会话先结束的
 * 回合先发，不乱序。
 *
 * 排队且目标会话正在跑时，先到的 `turn/end` 属于上一轮，不能当成这一轮的回答。
 */

import { asRecord, textFromAssistantMessage } from './session-text.ts';

const SEND_TIMEOUT_MS = 30 * 60_000;
const MAX_PENDING = 20;
const UNTITLED = '未命名会话';

export interface SendWatchTarget {
  chatId: string;
  replyTo?: string;
  /** 触发投递的平台消息 id：回答送达后才补 `DONE`。 */
  platformMessageId: string;
}

export interface SendWatcherOptions {
  /** 把一段文本发回飞书；返回是否真的发出去了。 */
  deliver: (target: SendWatchTarget, text: string) => Promise<boolean>;
  /** 正常回答送达后回调（补 `DONE`）；失败、中止、超时都不调。 */
  onDelivered?: (platformMessageId: string) => void;
  now?: () => number;
  logger?: { warn?(...args: unknown[]): unknown };
  timeoutMs?: number;
  maxPending?: number;
  /** 测试注入的定时器（生产用 `setTimeout().unref()`）。 */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface SendWatch {
  title: string;
  target: SendWatchTarget;
  until: number;
  /**
   * 提交时目标会话正在跑、且用的是排队：我们这条还没轮到，先到的 `turn/end` 属于
   * 上一轮，不能当成「这一轮的回答」发回去。
   */
  pendingStart: boolean;
  timer: unknown;
}

interface TurnState {
  answer: string;
}

type Outcome = { kind: 'ok' } | { kind: 'aborted' } | { kind: 'blocked' } | { kind: 'failed'; detail: string };

function defaultSetTimer(callback: () => void, ms: number): unknown {
  const handle = setTimeout(callback, ms);
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export class SendWatcher {
  readonly #deliver: (target: SendWatchTarget, text: string) => Promise<boolean>;
  readonly #onDelivered: ((platformMessageId: string) => void) | undefined;
  readonly #now: () => number;
  readonly #logger: SendWatcherOptions['logger'];
  readonly #timeoutMs: number;
  readonly #maxPending: number;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #watches = new Map<string, SendWatch>();
  readonly #turns = new Map<string, TurnState>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: SendWatcherOptions) {
    this.#deliver = options.deliver;
    this.#onDelivered = options.onDelivered;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
    this.#maxPending = options.maxPending ?? MAX_PENDING;
    this.#setTimer = options.setTimer ?? defaultSetTimer;
    this.#clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  /** 受理一次投递：`queued` 表示目标会话正在跑、这一条排在后面。 */
  track(sessionId: string, title: string, target: SendWatchTarget, queued = false): 'ok' | 'busy' | 'full' {
    if (this.#watches.has(sessionId)) return 'busy';
    if (this.#watches.size >= this.#maxPending) return 'full';
    const until = this.#now() + this.#timeoutMs;
    const timer = this.#setTimer(() => this.#expire(sessionId, until), this.#timeoutMs);
    this.#watches.set(sessionId, { title, target, until, pendingStart: queued, timer });
    this.#turns.set(sessionId, { answer: '' });
    return 'ok';
  }

  /** 这个会话是否还有投递在等回答（切换前要拦）。 */
  has(sessionId: string): boolean {
    return this.#watches.has(sessionId);
  }

  /** 提交失败时撤销刚登记的观察（不留下一个永远等不到的条目）。 */
  remove(sessionId: string): void {
    const watch = this.#watches.get(sessionId);
    if (watch === undefined) return;
    this.#clearTimer(watch.timer);
    this.#watches.delete(sessionId);
    this.#turns.delete(sessionId);
  }

  /** `session/event` 回调：同步折叠，不抛错。 */
  handleEvent(sessionId: string, event: unknown): void {
    try {
      this.#apply(sessionId, asRecord(event));
    } catch (error) {
      this.#logger?.warn?.('独立模式投递事件处理失败', error instanceof Error ? error.message : String(error));
    }
  }

  /** 停机：只收定时器；没发完的推送不再等。 */
  stop(): void {
    for (const watch of this.#watches.values()) this.#clearTimer(watch.timer);
    this.#watches.clear();
    this.#turns.clear();
  }

  /** 等所有排队中的推送发完（测试与停机时用）。 */
  async drain(): Promise<void> {
    await Promise.all([...this.#queues.values()]);
  }

  #apply(sessionId: string, event: Record<string, any> | null): void {
    if (event === null || typeof event.type !== 'string') return;
    const watch = this.#watches.get(sessionId);
    if (watch === undefined) return;

    if (event.type === 'session/title') {
      const title = typeof event.data?.title === 'string' ? event.data.title.trim() : '';
      if (title !== '') watch.title = title;
      return;
    }

    const data = asRecord(event.data) ?? {};
    if (event.type === 'turn/start') {
      // 我们这一轮开始了：排队时先到的上一轮收尾不再需要跳过。
      watch.pendingStart = false;
      this.#turns.set(sessionId, { answer: '' });
      return;
    }

    if (event.type === 'assistant/message') {
      const text = textFromAssistantMessage(data.message);
      if (text === '') return;
      const turn = this.#turns.get(sessionId) ?? { answer: '' };
      turn.answer = text;
      this.#turns.set(sessionId, turn);
      return;
    }

    if (event.type !== 'turn/end') return;
    const turn = this.#turns.get(sessionId) ?? { answer: '' };
    this.#turns.delete(sessionId);
    if (watch.pendingStart) {
      // 排队期间结束的是上一轮；我们这条还在队列里，等它自己的回合。
      watch.pendingStart = false;
      return;
    }
    this.#finish(sessionId, watch, turn, asRecord(data.reason));
  }

  #finish(sessionId: string, watch: SendWatch, turn: TurnState, reason: Record<string, any> | null): void {
    this.#clearTimer(watch.timer);
    this.#watches.delete(sessionId);
    const outcome = reasonOf(reason);
    const title = watch.title || UNTITLED;
    const answer = turn.answer.trim();
    this.#enqueue(sessionId, async () => {
      let text: string;
      if (outcome.kind === 'aborted') text = `「${title}」这一轮被中止了。`;
      else if (outcome.kind === 'blocked') text = `「${title}」这一轮被拦下了（可能在等审批），请到 Web 端处理。`;
      else if (outcome.kind === 'failed') text = `「${title}」这一轮失败：${outcome.detail}`;
      else if (answer === '') text = `「${title}」这一轮结束了，没有可发送的文本。`;
      else text = `来自会话「${title}」：\n\n${answer}`;
      const sent = await this.#deliver(watch.target, text).catch((error: unknown) => {
        this.#logger?.warn?.('独立模式投递推送失败', error instanceof Error ? error.message : String(error));
        return false;
      });
      // 只有正常收尾且真的发出了回答才补 DONE；失败/中止/无文本都不给假信号。
      if (sent && outcome.kind === 'ok' && answer !== '') this.#onDelivered?.(watch.target.platformMessageId);
    });
  }

  #expire(sessionId: string, until: number): void {
    const watch = this.#watches.get(sessionId);
    if (watch === undefined || watch.until !== until) return;
    this.#watches.delete(sessionId);
    this.#turns.delete(sessionId);
    const minutes = Math.round(this.#timeoutMs / 60_000);
    this.#enqueue(sessionId, async () => {
      await this.#deliver(watch.target, `「${watch.title || UNTITLED}」这一轮没有在 ${minutes} 分钟内结束，不再等它了。`).catch(
        (error: unknown) => {
          this.#logger?.warn?.('独立模式投递超时提示发送失败', error instanceof Error ? error.message : String(error));
          return false;
        },
      );
    });
  }

  /** 同一会话的推送串行：先结束的回合先发，不乱序。 */
  #enqueue(sessionId: string, task: () => Promise<void>): void {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.#logger?.warn?.('独立模式投递推送失败', error instanceof Error ? error.message : String(error));
    });
    this.#queues.set(sessionId, next);
    void next.finally(() => {
      if (this.#queues.get(sessionId) === next) this.#queues.delete(sessionId);
    });
  }
}

/** 一轮的结局：`completed`/`max-tokens` 之外的收尾文案。 */
function reasonOf(reason: Record<string, any> | null): Outcome {
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed';
  if (kind === 'aborted') return { kind: 'aborted' };
  if (kind === 'blocked') return { kind: 'blocked' };
  if (kind === 'completed' || kind === 'max-tokens') return { kind: 'ok' };
  const error = asRecord(reason?.error);
  const detail = typeof error?.message === 'string' ? error.message : '模型或工具报错';
  return { kind: 'failed', detail: detail.slice(0, 300) };
}
