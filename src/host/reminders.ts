/**
 * 提问与授权提醒的装配点：两个 broker + 面板上的开关与等待时间。
 *
 * 这里只做四件事：
 * 1. 把宿主的 `user-questions/request` 与 `approval/request` 转给两个 broker；
 * 2. 入站文本按「最后发的那条提醒」决定归属（提问的自由输入会吞掉一切）；
 * 3. 提醒发送限速：飞书按用户 5 QPS，但提醒是打扰性消息，自己再收紧到 6 条/分钟、
 *    两条之间至少 2 秒，避免一批待授权在一分钟内齐发；
 * 4. 保存开关与等待时间，关掉时把在等的请求交回 Web。
 */

import { ApprovalBroker } from './approvals.ts';
import type { Card } from './cards.ts';
import type { ApprovalNext } from './approvals.ts';
import { QuestionBroker } from './questions.ts';
import type { QuestionNext, QuestionRequest, ReminderLogger } from './questions.ts';
import { DEFAULT_QUESTION_DELAY_MINUTES, MAX_QUESTION_DELAY_MINUTES, normalizeQuestionDelayMinutes } from './config.ts';
import type { ApprovalRequest } from './reminder-text.ts';

/** 最后一条提醒来自哪一路：入站文本先给这一路认领。 */
type ReminderKind = 'question' | 'approval';

/** 会话来源：子代理 / 根会话 / 拿不到（服务缺席、形状不认识）。 */
type Origin = 'subagent' | 'root' | 'unknown';

function originOf(agent: unknown): Origin {
  const record = agent !== null && typeof agent === 'object' ? (agent as Record<string, unknown>) : null;
  const session = record?.session;
  const header = session !== null && typeof session === 'object'
    ? (session as Record<string, unknown>).header
    : null;
  if (header === null || typeof header !== 'object') return 'unknown';
  return (header as Record<string, unknown>).origin === 'subagent' ? 'subagent' : 'root';
}

/** 提醒类判据：明确是子代理才拒绝，拿不准时放行。 */
function isRootAgent(agent: unknown): boolean {
  return originOf(agent) !== 'subagent';
}

/** 授权类判据：必须确认是根会话，拿不准一律拒绝（失败关闭）。 */
function canApproveAgent(agent: unknown): boolean {
  return originOf(agent) === 'root';
}

const GATE_WINDOW_MS = 60_000;
const GATE_MAX = 6;
const GATE_GAP_MS = 2_000;

/** 提醒发送限速：窗口内最多 6 条，相邻两条至少隔 2 秒。 */
class SendGate {
  readonly #now: () => number;
  readonly #stamps: number[] = [];

  constructor(now: () => number) {
    this.#now = now;
  }

  /** 等到可以发；返回前先占一个名额。 */
  async wait(): Promise<void> {
    for (;;) {
      const now = this.#now();
      while (this.#stamps.length > 0 && now - this.#stamps[0]! >= GATE_WINDOW_MS) this.#stamps.shift();
      const last = this.#stamps[this.#stamps.length - 1];
      const waitMs = Math.max(
        last === undefined ? 0 : last + GATE_GAP_MS - now,
        this.#stamps.length < GATE_MAX ? 0 : this.#stamps[0]! + GATE_WINDOW_MS - now,
      );
      if (waitMs <= 0) {
        this.#stamps.push(now);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(waitMs, 5_000)));
    }
  }
}

export interface ReminderCenterOptions {
  send: (text: string) => Promise<boolean>;
  /** 发一张可作答的卡片（返回平台消息 id）；没配置时提问一律走文字。 */
  sendCard?: (card: Card) => Promise<string | null>;
  /** 把已发出的卡片改成终态；失败只记日志。 */
  patchCard?: (messageId: string, card: Card) => Promise<void>;
  recipient: () => string | null;
  /** 当前是否仍然允许接管（独立模式且连接可用）。 */
  isActive: () => boolean;
  /** 启动时的设置（面板值或静态配置）。 */
  enabled: boolean;
  delayMinutes: number;
  logger?: ReminderLogger;
  now?: () => number;
}

export interface ReminderStatus {
  enabled: boolean;
  delayMinutes: number;
  pendingQuestions: number;
  pendingApprovals: number;
  lastError?: { at: number; message: string };
}

export class ReminderCenter {
  readonly #options: ReminderCenterOptions;
  readonly #gate: SendGate;
  readonly #questions: QuestionBroker;
  readonly #approvals: ApprovalBroker;
  #enabled: boolean;
  #delayMinutes: number;
  #lastSent: ReminderKind = 'question';

  constructor(options: ReminderCenterOptions) {
    this.#options = options;
    this.#enabled = options.enabled;
    this.#delayMinutes = options.delayMinutes;
    this.#gate = new SendGate(options.now ?? Date.now);

    const shared = {
      send: (text: string) => this.#deliver(text),
      recipient: options.recipient,
      isActive: options.isActive,
      enabled: () => this.#enabled,
      delayMs: () => this.#delayMinutes * 60_000,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.now === undefined ? {} : { now: options.now }),
    };
    this.#questions = new QuestionBroker({
      ...shared,
      ...(options.sendCard === undefined ? {} : { sendCard: (card: Card) => this.#deliverCard(card) }),
      ...(options.patchCard === undefined ? {} : { patchCard: options.patchCard }),
      isRoot: isRootAgent,
      onSent: () => {
        this.#lastSent = 'question';
      },
    });
    this.#approvals = new ApprovalBroker({
      ...shared,
      canApprove: canApproveAgent,
      onSent: () => {
        this.#lastSent = 'approval';
      },
    });
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get delayMinutes(): number {
    return this.#delayMinutes;
  }

  status(): ReminderStatus {
    const questions = this.#questions.snapshot();
    const approvals = this.#approvals.snapshot();
    return {
      enabled: this.#enabled,
      delayMinutes: this.#delayMinutes,
      pendingQuestions: questions.pending,
      pendingApprovals: approvals.pending,
      ...(questions.lastError === undefined ? {} : { lastError: questions.lastError }),
    };
  }

  handleQuestion(request: QuestionRequest, next: QuestionNext, active: boolean): Promise<unknown> {
    return this.#questions.handle(request, next, active);
  }

  handleApproval(request: ApprovalRequest, next: ApprovalNext, active: boolean): Promise<unknown> {
    return this.#approvals.handle(request, next, active);
  }

  /** 卡片回调：只可能是提问卡；返回 true 表示这条回调已被消化。 */
  applyCardAction(action: {
    value: Record<string, unknown>;
    option?: unknown;
    formValues?: Record<string, unknown>;
  }): boolean {
    return this.#questions.applyCardAction(action);
  }

  /**
   * 入站文本先认最后发的那条提醒。
   *
   * 单题提问认任意文本（自由输入），不按发送顺序的话，审批的「批准」会被它吞掉。
   * 顺序由本类记录——两个 broker 各自计数不可比（各发一次时恒为 1:1）。
   */
  reply(text: string): boolean {
    const claimed = this.#lastSent === 'approval'
      ? this.#approvals.reply(text) || this.#questions.reply(text)
      : this.#questions.reply(text) || this.#approvals.reply(text);
    return claimed;
  }

  /** 更新设置；关掉时把在等的请求交回 Web，别挂到超时。 */
  configure(patch: { enabled?: boolean; delayMinutes?: number }): void {
    if (typeof patch.enabled === 'boolean') this.#enabled = patch.enabled;
    const delay = normalizeQuestionDelayMinutes(patch.delayMinutes);
    if (delay !== undefined) this.#delayMinutes = Math.min(delay, MAX_QUESTION_DELAY_MINUTES);
    if (!this.#enabled) this.cancelAll('提醒已关闭，交回 Web 端');
  }

  /** 停机/切换接入：把在等的提问与审批按真实原因交回 Web。 */
  cancelAll(reason: string): void {
    this.#questions.cancelAll(reason);
    this.#approvals.cancelAll(reason);
  }

  close(): void {
    this.#questions.close();
    this.#approvals.close();
  }

  async #deliverCard(card: Card): Promise<string | null> {
    if (!this.#options.isActive() || this.#options.sendCard === undefined) return null;
    await this.#gate.wait();
    if (!this.#options.isActive()) return null;
    try {
      return await this.#options.sendCard(card);
    } catch (error) {
      this.#options.logger?.warn?.('提问卡片发送失败', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async #deliver(text: string): Promise<boolean> {
    if (!this.#options.isActive()) return false;
    await this.#gate.wait();
    if (!this.#options.isActive()) return false;
    try {
      return await this.#options.send(text);
    } catch (error) {
      this.#options.logger?.warn?.('提醒发送失败', error instanceof Error ? error.message : String(error));
      return false;
    }
  }
}

export { DEFAULT_QUESTION_DELAY_MINUTES };
