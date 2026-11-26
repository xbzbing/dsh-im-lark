/**
 * 长程任务提醒与失败任务提醒。
 *
 * 订阅宿主的 `session/event`，按会话跟踪回合：`turn/start` 记开始时间，
 * `assistant/message` 攒最后一段可见文本，`turn/end` 判成败。两类提醒的判据不同：
 *
 * - **长程任务**：回合耗时超过阈值（默认 30 分钟）且正常结束，把「标题 + 耗时 +
 *   结论」发到飞书。阈值全程用**分钟**，配置、面板、状态都是同一个数。
 * - **失败任务**：回合以失败 / 被外部中止收场，**不看耗时**立刻提醒 —— 任务没做成
 *   是主人必须知道的事。
 *
 * 两条硬约束：
 *
 * 1. 只在独立模式生效。接入核心后提醒由核心发交付，这里再来一条就是打扰两遍。
 * 2. 子代理会话一律不提醒：一个并行子任务能刷屏。拿不到会话来源时放行，宁可多
 *    提醒一条。
 *
 * 主人自己按了停止（`reason.reason.kind === 'user'`）不算失败，静默丢弃。
 */

import { textFromAssistantMessage } from './session-text.ts';

export interface LongTaskLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

export interface LongTaskNotifierOptions {
  /** 发提醒（纯文本）；返回是否真的发出去了。 */
  send: (text: string) => Promise<boolean>;
  /** 收件人；没有主人时返回 null。 */
  recipient: () => string | null;
  /** 提示是否该工作：独立模式生效时才为真。 */
  isActive: () => boolean;
  /** 会话标题；取不到时提醒里显示「未命名会话」。 */
  titleOf?: (sessionId: string) => string | null;
  /**
   * 完成提醒是否要跳过这个会话。
   *
   * 独立模式绑定的那个会话在 `turn/end` 已经把回答发回飞书，再补一条「长程任务完成」
   * 等于同一件事说两遍。失败提醒不走这条判断：失败时回答往往是空的，那条提醒才是
   * 唯一的信号。
   */
  suppressCompletion?: (sessionId: string) => boolean;
  now?: () => number;
  logger?: LongTaskLogger;
  /** 长程任务提醒开关（默认开）。 */
  enabled?: boolean;
  /** 失败任务提醒开关（默认开）。 */
  failureReminders?: boolean;
  /** 超过这么多分钟才算长任务（默认 30）。 */
  thresholdMinutes?: number;
  /** 单条提醒的字符上限，超长截断。 */
  maxChars?: number;
  /** 同时跟踪的会话上限。 */
  maxTracked?: number;
}

interface SessionRecord {
  startedAt: number;
  turn: number | undefined;
  answer: string;
  running: boolean;
}

/** 长程任务阈值（分钟）：默认半小时。 */
export const DEFAULT_LONG_TASK_MINUTES = 30;
export const MIN_LONG_TASK_MINUTES = 1;
export const MAX_LONG_TASK_MINUTES = 24 * 60;

const MINUTE_MS = 60_000;
const DEFAULT_MAX_CHARS = 1_800;
const TRACKED_MAX = 100;
const UNTITLED_SESSION = '未命名会话';

/** 把外部给的分钟数收窄到可用区间；不是数字返回 undefined（调用方回落到默认）。 */
export function normalizeLongTaskMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < MIN_LONG_TASK_MINUTES || rounded > MAX_LONG_TASK_MINUTES) return undefined;
  return rounded;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** 耗时文案：不足一分钟只说秒，够一分钟带分。 */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

/**
 * 提醒正文：一行结论（完成 / 失败）、耗时、结论摘要。
 *
 * 失败时把平台的原始原因带上：额度用尽、provider 超时这类信息读原文最快。
 */
export function longTaskText(params: {
  title: string;
  durationMs: number;
  failed: boolean;
  failure?: string;
  answer: string;
  maxChars: number;
}): string {
  const heading = `${params.failed ? '任务失败' : '长程任务完成'} · ${params.title}`;
  const meta = [
    `耗时：${durationText(params.durationMs)}`,
    `结果：${params.failed ? '执行失败' : '已完成'}`,
    params.failed && params.failure !== undefined && params.failure !== '' ? `原因：${params.failure.slice(0, 300)}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
  const body = params.answer.trim();
  const text = body === '' ? `${heading}\n\n${meta}\n\n没有可提取的文本结论，请到 Web 查看。` : `${heading}\n\n${meta}\n\n${body}`;
  return text.length <= params.maxChars ? text : `${text.slice(0, Math.max(0, params.maxChars - 1))}…`;
}

export class LongTaskNotifier {
  readonly #options: LongTaskNotifierOptions;
  readonly #now: () => number;
  readonly #maxChars: number;
  readonly #maxTracked: number;
  readonly #records = new Map<string, SessionRecord>();
  #enabled: boolean;
  #failureReminders: boolean;
  #thresholdMinutes: number;

  constructor(options: LongTaskNotifierOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.#maxTracked = options.maxTracked ?? TRACKED_MAX;
    this.#enabled = options.enabled ?? true;
    this.#failureReminders = options.failureReminders ?? true;
    this.#thresholdMinutes = options.thresholdMinutes ?? DEFAULT_LONG_TASK_MINUTES;
  }

  /** 面板保存后调用：改开关与阈值，对已经跟踪的回合同样生效。 */
  configure(patch: {
    enabled?: boolean;
    failureReminders?: boolean;
    thresholdMinutes?: number;
  }): void {
    if (patch.enabled !== undefined) this.#enabled = patch.enabled;
    if (patch.failureReminders !== undefined) this.#failureReminders = patch.failureReminders;
    if (patch.thresholdMinutes !== undefined) this.#thresholdMinutes = patch.thresholdMinutes;
    if (!this.#enabled && !this.#failureReminders) this.clear();
  }

  get thresholdMinutes(): number {
    return this.#thresholdMinutes;
  }

  get tracking(): number {
    return this.#records.size;
  }

  clear(): void {
    this.#records.clear();
  }

  /** 会话销毁时清掉跟踪。 */
  clearSession(sessionId: string): void {
    this.#records.delete(sessionId);
  }

  /**
   * `session/event` 监听器。
   *
   * 不按开关早退：完成提醒看 `#enabled`，失败看 `#failureReminders`，要跟到
   * `turn/end` 才知道该走哪条路。
   */
  handleEvent(session: unknown, event: unknown): void {
    if (!this.#options.isActive()) return;
    const sessionId = typeof session === 'string' ? session : String(asRecord(session)?.id ?? '');
    if (sessionId === '') return;
    if (!isRootSession(session)) return;

    const entry = asRecord(event);
    if (entry === null || typeof entry.type !== 'string') return;
    const data = asRecord(entry.data) ?? {};
    const at = typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : this.#now();

    switch (entry.type) {
      case 'turn/start':
        this.#start(sessionId, typeof data.turn === 'number' ? data.turn : undefined, at);
        return;
      case 'assistant/message': {
        const record = this.#records.get(sessionId);
        if (record === undefined) return;
        const text = textFromAssistantMessage(data.message);
        if (text.trim() !== '') record.answer = text;
        return;
      }
      case 'turn/end':
        this.#end(sessionId, data, at);
        return;
      default:
        return;
    }
  }

  #start(sessionId: string, turn: number | undefined, at: number): void {
    const existing = this.#records.get(sessionId);
    if (existing !== undefined && existing.running && existing.turn === turn) return;
    // 重新覆盖写入：新回合的答案不能继承上一轮。
    this.#records.set(sessionId, { startedAt: at, turn, answer: '', running: true });
    while (this.#records.size > this.#maxTracked) {
      const oldest = this.#records.keys().next();
      if (oldest.done) break;
      this.#records.delete(oldest.value);
    }
  }

  #end(sessionId: string, data: Record<string, unknown>, at: number): void {
    const record = this.#records.get(sessionId);
    if (record === undefined || !record.running) return;
    record.running = false;
    const durationMs = at - record.startedAt;

    // 宿主的 turn/end 是 `{ turn, reason }`：`reason.kind` 才是成败，`reason.error`
    // 带平台原文，`reason.reason.kind === 'user'` 表示主人自己按了停止。
    const reason = asRecord(data.reason);
    const kind = typeof reason?.kind === 'string' ? reason.kind : '';
    const byOwner = asRecord(reason?.reason)?.kind === 'user';
    if (kind === 'aborted' && byOwner) {
      this.#records.delete(sessionId);
      return;
    }
    const failed = kind === 'aborted' || (kind !== '' && kind !== 'completed' && kind !== 'max-tokens');
    const failure = typeof asRecord(reason?.error)?.message === 'string' ? String(asRecord(reason?.error)?.message) : '';

    if (failed) {
      if (!this.#failureReminders) {
        this.#records.delete(sessionId);
        return;
      }
    } else if (!this.#enabled || durationMs <= this.#thresholdMinutes * MINUTE_MS) {
      this.#records.delete(sessionId);
      return;
    } else if (this.#skipCompletion(sessionId)) {
      this.#records.delete(sessionId);
      return;
    }

    if (this.#options.recipient() === null) {
      this.#records.delete(sessionId);
      return;
    }

    const text = longTaskText({
      title: this.#title(sessionId),
      durationMs,
      failed,
      ...(failure === '' ? {} : { failure }),
      answer: record.answer,
      maxChars: this.#maxChars,
    });
    this.#records.delete(sessionId);
    void this.#options.send(text).catch((error: unknown) => {
      this.#options.logger?.warn?.('任务提醒发送失败', error instanceof Error ? error.message : String(error));
    });
  }

  #skipCompletion(sessionId: string): boolean {
    try {
      return this.#options.suppressCompletion?.(sessionId) === true;
    } catch {
      // 判断失败按「不跳过」处理：宁可多提醒一条，也别把回音吞掉。
      return false;
    }
  }

  #title(sessionId: string): string {
    try {
      const title = this.#options.titleOf?.(sessionId);
      return title !== null && title !== undefined && title.trim() !== '' ? title.trim() : UNTITLED_SESSION;
    } catch {
      return UNTITLED_SESSION;
    }
  }
}

/**
 * 只有子代理会话要排除，别的都算根会话。
 *
 * 来源字段是 `session.header.origin`（与宿主 `dsh-user-questions` 的根会话判据同源）。
 * 拿不到 header 时放行：少提醒比漏提醒更难发现。
 */
function isRootSession(session: unknown): boolean {
  const header = asRecord(asRecord(session)?.header);
  return header?.origin !== 'subagent';
}
