/**
 * 问题提醒（独立模式）：宿主问主人时，把题目发到飞书并等主人回话。
 *
 * DSH 的 `user-questions/request` 是 Cordis waterfall：监听器返回答案，或者 `next()`
 * 把请求交给下一个监听器（Web 端也在链上）。本 broker 注册在链首，做三件事：
 *
 * 1. 先把请求交给 Web，等 `delayMs`：这段时间在 Web 端答完就一条飞书都不发；
 * 2. 到点把题目渲染成文字发给主人；
 * 3. 与 Web **竞答**：谁先答用谁——主人先答就把本地信号 abort，Web 的投递随之作废。
 *
 * 只在「没有接入超级助理」时启用：接入了核心就由核心发卡片，再提醒一次会打扰两遍。
 */

import { answerFromText, classifyAnswer, normalizeQuestions, renderQuestions, resolvesToOption } from './reminder-text.ts';
import type { AskQuestion, Answer } from './reminder-text.ts';
import { answerFromCard, isCardAnswerable, renderReminderCard, renderReminderClosedCard } from './reminder-card.ts';
import type { Card } from './cards.ts';
import { PendingTable, abortReason, deferred, whenAborted } from './reminder-pending.ts';

export interface ReminderLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

/** waterfall 的请求对象：`signal` 要原地替换，不能是 readonly。 */
export interface QuestionRequest {
  questions?: unknown;
  agent?: { id?: unknown } | null;
  signal?: AbortSignal;
  wait?: { callId?: unknown; timed?: unknown };
}

export type QuestionNext = () => Promise<unknown>;

export interface QuestionBrokerOptions {
  /** 把提醒文本发给主人；返回是否发出去了。 */
  send: (text: string) => Promise<boolean>;
  /** 发一张可作答的卡片，返回平台消息 id；没发出时 null（调用方退回文字）。 */
  sendCard?: (card: Card) => Promise<string | null>;
  /** 把已发出的卡片改成终态（已作答/已失效），失败只记日志。 */
  patchCard?: (messageId: string, card: Card) => Promise<void>;
  /** 收件人（主人）；没登录/停用时应返回 null，此时完全不接管。 */
  recipient: () => string | null;
  /** 只提醒根会话（子代理的提问不打扰主人）；拿不到来源时放行。 */
  isRoot: (agent: unknown) => boolean;
  /** 当前是否仍然允许接管；发送提醒期间可能被停用/切到核心。 */
  isActive?: () => boolean;
  /** 面板上的「问题与审批提醒」开关：关掉后一律交回 Web。 */
  enabled?: () => boolean;
  /** 提醒前的等待时间（毫秒）：这段时间在 Web 端答完就不打扰。 */
  delayMs?: () => number;
  /** 发出提醒后通知协调者：入站文本该先给这一路认领。 */
  onSent?: () => void;
  now?: () => number;
  newId?: () => string;
  logger?: ReminderLogger;
  /** 单次提醒最多等多久（到点后交回 Web，不再接受飞书作答）。 */
  waitMs?: number;
}

interface Pending {
  readonly id: string;
  /** 提醒编号（#N）：卡片标题与终态卡都要用。 */
  readonly no: number;
  readonly questions: AskQuestion[];
  /** 卡片消息 id；文字提醒没有。 */
  readonly cardMessageId?: string;
  /** 本地取消器：abort 会连带 abort 宿主看到的 union signal，Web 端据此收起卡片。 */
  readonly cancel: AbortController;
  resolve(answer: Answer): void;
  reject(error: unknown): void;
}

/** 「没有监听者」：说明 Web 端根本不在，不算作答，继续等飞书。 */
function isNoProvider(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'NO_PROVIDER';
}

const DEFAULT_WAIT_MS = 30 * 60_000;
const PENDING_MAX = 50;

export interface QuestionSnapshot {
  pending: number;
  lastError?: { at: number; message: string };
}

export class QuestionBroker {
  readonly #options: QuestionBrokerOptions;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #waitMs: number;
  readonly #pending = new PendingTable<Pending>(PENDING_MAX);
  #lastError: { at: number; message: string } | undefined;
  #closed = false;
  /** 提醒编号：只在文案里用，便于主人说「回答第 2 条」。 */
  #reminded = 0;

  constructor(options: QuestionBrokerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    let counter = 0;
    this.#newId = options.newId ?? (() => `lark-q-${++counter}`);
    this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  }

  snapshot(): QuestionSnapshot {
    return {
      pending: this.#pending.size,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    };
  }

  /** `user-questions/request` 的监听器实现；不接管时原样 `next()`。 */
  async handle(request: QuestionRequest, next: QuestionNext, active: boolean): Promise<unknown> {
    if (!active || this.#closed || !this.#takesOver()) return next();
    const questions = normalizeQuestions(request.questions);
    if (questions.length === 0) return next();
    if (this.#options.recipient() === null) return next();
    if (!this.#options.isRoot(request.agent)) return next();

    // 先把信号换成 union：Web 端与宿主拿到的是同一个可被我们撤销的信号。
    const original = request.signal;
    const local = new AbortController();
    request.signal = original === undefined ? local.signal : AbortSignal.any([original, local.signal]);
    const web = next();
    const webSettled: Promise<WebOutcome> = web.then(
      (value) => ({ kind: 'web', value }),
      (error: unknown) => (isNoProvider(error) ? { kind: 'none' } : { kind: 'web-error', error }),
    );
    const aborted = whenAborted(request.signal);

    const delay = this.#delayMs();
    const waited = deferred<void>();
    const delayTimer = delay > 0 ? setTimeout(() => waited.resolve(), delay) : null;
    delayTimer?.unref?.();
    const no = ++this.#reminded;
    const text = renderQuestions(questions, no);
    // 卡片回调要带着 id 找回待答，所以先领号再发。
    const pendingId = this.#newId();

    try {
      if (delay > 0) {
        const early = await Promise.race([
          webSettled,
          aborted.promise.then(() => ({ kind: 'aborted' as const })),
          waited.promise.then(() => ({ kind: 'go' as const })),
        ]);
        if (early.kind === 'web') return early.value;
        if (early.kind === 'web-error') throw early.error;
        if (early.kind === 'aborted') throw cancellation(request);
      }

      const card = this.#cardFor(pendingId, no, questions);
      let messageId: string | null = null;
      if (card !== null) {
        messageId = await this.#options.sendCard!(card).catch(() => null);
      }
      // 卡片发失败（平台拒绝、超限）就退回文字：卡片的可用性不该决定提醒发不发。
      const sent = messageId !== null || (await this.#options.send(text).catch(() => false));
      // 发送是异步的；这期间可能已经停用/切到核心，cancelAll 看不到尚不存在的 pending。
      if (this.#closed || (this.#options.isActive !== undefined && !this.#options.isActive())) {
        this.#closeCardOf(messageId ?? undefined, no, questions, '这条提醒已作废。');
        this.#noteError('问题提醒发送期间插件状态已变化，已交回 Web 端');
        return web;
      }
      if (!sent) {
        this.#noteError('问题提醒发送失败，已交回 Web 端');
        return web;
      }
      // 发送期间 Web 已经答完（或请求已取消）：别再挂一条过时的提醒。
      const late = await Promise.race([
        webSettled,
        aborted.promise.then(() => ({ kind: 'aborted' as const })),
        Promise.resolve({ kind: 'continue' as const }),
      ]);
      if (late.kind === 'web') {
        this.#closeCardOf(messageId ?? undefined, no, questions, '已在 Web 端作答，这条提醒失效。');
        return late.value;
      }
      if (late.kind === 'web-error') throw late.error;
      if (late.kind === 'aborted') {
        this.#closeCardOf(messageId ?? undefined, no, questions, '这条提醒已作废。');
        throw cancellation(request);
      }

      const answer = deferred<Answer>();
      const pending: Pending = {
        id: pendingId,
        no,
        questions,
        cancel: local,
        ...(messageId === null ? {} : { cardMessageId: messageId }),
        resolve: (value) => answer.resolve(value),
        reject: (error) => answer.reject(error),
      };
      this.#pending.add(pending);
      for (const dropped of this.#pending.sweep()) this.#drop(dropped);
      this.#options.onSent?.();

      const im = answer.promise.then(
        (value) => ({ kind: 'im' as const, value }),
        (error: unknown) => ({ kind: 'im-error' as const, error }),
      );
      const timeout = deferred<{ kind: 'timeout' }>();
      const timer = setTimeout(() => {
        this.#pending.delete(pendingId);
        timeout.resolve({ kind: 'timeout' });
      }, this.#waitMs);
      timer.unref?.();

      try {
        let outcome = await Promise.race([
          webSettled,
          im,
          aborted.promise.then(() => ({ kind: 'aborted' as const })),
          timeout.promise,
        ]);
        if (outcome.kind === 'none') {
          // Web 不在：只等主人作答、请求取消或超时。
          outcome = await Promise.race([
            im,
            aborted.promise.then(() => ({ kind: 'aborted' as const })),
            timeout.promise,
          ]);
        }
        if (outcome.kind === 'im') {
          local.abort(abortReason('已在飞书作答'));
          this.#options.logger?.info?.('问题已在飞书作答，Web 端投递作废');
          return outcome.value;
        }
        if (outcome.kind === 'web') {
          this.#closeCard(pending, '已在 Web 端作答，这条提醒失效。');
          return outcome.value;
        }
        if (outcome.kind === 'web-error') throw outcome.error;
        if (outcome.kind === 'im-error') {
          this.#closeCard(pending, '飞书作答失败，请在 Web 端作答。');
          throw outcome.error;
        }
        if (outcome.kind === 'timeout') {
          // 飞书这路到点放弃：Web 还在就真正交回，由它接着等作答。
          const webOutcome = await Promise.race([
            webSettled,
            aborted.promise.then(() => ({ kind: 'aborted' as const })),
          ]);
          if (webOutcome.kind === 'web') {
            this.#closeCard(pending, '已在 Web 端作答，这条提醒失效。');
            return webOutcome.value;
          }
          if (webOutcome.kind === 'web-error') throw webOutcome.error;
          this.#closeCard(pending, '等待超时，已交回 Web 端。');
          if (webOutcome.kind === 'none') throw abortReason('等待飞书作答超时');
        }
        // 带上取消方的原因：停机、切换接入方式、宿主自己取消，各自有可读的话。
        this.#closeCard(pending, '这条提醒已作废。');
        throw cancellation(request);
      } finally {
        clearTimeout(timer);
        this.#pending.delete(pendingId);
      }
    } finally {
      if (delayTimer !== null) clearTimeout(delayTimer);
      aborted.dispose();
    }
  }

  /**
   * 入站文本尝试当作作答；返回 true 表示这条消息已被消化（不再进普通消息路径）。
   * 多条待答时认**最后一条**：主人在飞书里看到的是最近发出的那条提醒。
   */
  reply(text: string): boolean {
    for (const pending of this.#pending.newestFirst()) {
      // 文字提醒没有「其他」输入框：单题仍接受任意文本当自定义答案。
      const claim = classifyAnswer(pending.questions, text, { allowCustom: pending.cardMessageId === undefined });
      if (claim === null) continue;
      if (claim === 'partial') {
        this.#noteGuidance(pending, text);
        return true;
      }
      const answer = answerFromText(pending.questions, text);
      if (answer === null) continue;
      pending.resolve(answer);
      this.#pending.delete(pending.id);
      this.#closeCard(pending, `已在飞书作答：${describeAnswer(answer)}`);
      return true;
    }
    return false;
  }

  /**
   * 多题只答了几段：提醒里回一句格式提示，保留待答。
   *
   * 以前这种情况返回 false，这段话就掉进会话——两题提醒只回半句，模型没有题目上下文，
   * 只会再问一遍「你这两行是对应什么」。
   */
  #noteGuidance(pending: Pending, text: string): void {
    const segments = text.trim().split(/[；;。\n]+/u).map((segment) => segment.trim()).filter(Boolean);
    const bad = pending.questions
      .map((question, index) => ({ index, question, segment: segments[index] ?? '' }))
      .filter(({ question, segment }) => !resolvesToOption(question, segment))
      .map(({ index }) => index + 1);
    this.#options.logger?.info?.('多题作答不完整，提示格式', `#${pending.no} 第 ${bad.join('、')} 题`);
    const message = [
      `提醒 #${pending.no} 的作答不完整：第 ${bad.join('、')} 题没对上选项。`,
      '请按「选项序号或文字；选项序号或文字」逐题回复，例如「1；2」；这条提醒还在等你。',
    ].join('\n');
    void this.#options.send(message).catch(() => {});
  }

  /**
   * 卡片回调：认出是哪条提醒、结算作答；返回 true 表示这条回调已被消化。
   *
   * 认不出（不是本插件发的卡片、提醒已失效）返回 false，交给核心桥按「未知交付」
   * 处理——这样独立模式与核心模式的卡片回调走同一条入口。
   */
  applyCardAction(action: {
    value: Record<string, unknown>;
    option?: unknown;
    formValues?: Record<string, unknown>;
  }): boolean {
    const reminderId = typeof action.value.r === 'string' ? action.value.r : '';
    if (reminderId === '') return false;
    const pending = this.#pending.newestFirst().find((item) => item.id === reminderId);
    if (pending === undefined) return false;
    const questionId = typeof action.value.q === 'string' ? action.value.q : '';
    const question = pending.questions.find((item) => item.id === questionId);
    if (question === undefined) return false;
    const answer = answerFromCard(question, action.value, action.option, action.formValues);
    if (answer === null) return false;
    pending.resolve({ answers: [answer] });
    this.#pending.delete(pending.id);
    this.#closeCard(pending, `已在飞书作答：${answer.selected.join('、')}`);
    return true;
  }

  /** 停机/停用：把所有等待中的提问交回 Web（abort 本地信号，不吞掉请求）。 */
  cancelAll(reason = '插件已停止'): void {
    for (const pending of this.#pending.values()) {
      pending.cancel.abort(abortReason(reason));
      pending.reject(abortReason(reason));
      this.#closeCard(pending, `这条提醒已作废：${reason}`);
    }
    this.#pending.clear();
  }

  close(): void {
    this.#closed = true;
    this.cancelAll();
  }

  /** 面板开关：关掉就完全不接管，与没装插件一致。 */
  #takesOver(): boolean {
    return this.#options.enabled === undefined || this.#options.enabled();
  }

  /** 提醒前的等待时间；非法值当作不等。 */
  #delayMs(): number {
    const value = this.#options.delayMs?.() ?? 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /** 被挤掉的待答按「提问过多」收尾：abort 本地信号，Web 端随之收起。 */
  #drop(pending: Pending): void {
    pending.cancel.abort(abortReason('提问过多'));
    pending.reject(abortReason('提问过多'));
    this.#closeCard(pending, '提问过多，这条提醒已作废。');
  }

  /** 能上卡片就渲染一张；装不下/不是单题选择时返回 null，调用方退回文字。 */
  #cardFor(reminderId: string, no: number, questions: readonly AskQuestion[]): Card | null {
    if (this.#options.sendCard === undefined || !isCardAnswerable(questions)) return null;
    const question = questions[0];
    if (question === undefined) return null;
    try {
      return renderReminderCard({ reminderId, no, question });
    } catch {
      return null;
    }
  }

  /** 原卡片改终态；失败只记日志，不影响作答本身。 */
  #closeCard(pending: Pending, outcome: string): void {
    this.#closeCardOf(pending.cardMessageId, pending.no, pending.questions, outcome);
  }

  #closeCardOf(
    cardMessageId: string | undefined,
    no: number,
    questions: readonly AskQuestion[],
    outcome: string,
  ): void {
    if (cardMessageId === undefined || this.#options.patchCard === undefined) return;
    const question = questions[0];
    if (question === undefined) return;
    const card = renderReminderClosedCard({ no, question, outcome });
    void this.#options.patchCard(cardMessageId, card).catch(() => {});
  }

  #noteError(message: string): void {
    this.#lastError = { at: this.#now(), message };
  }
}

/** 文字作答的摘要：选项用「、」连起来，自由输入原样截断。 */
function describeAnswer(answer: Answer): string {
  const item = answer.answers[0];
  if (item === undefined) return '（空作答）';
  if (item.selected.length > 0) return item.selected.join('、');
  return (item.custom ?? '').slice(0, 60);
}

/** Web 端那一路的结果：答了、没有监听者、或者它自己出错。 */
export type WebOutcome =
  | { kind: 'web'; value: unknown }
  | { kind: 'none' }
  | { kind: 'web-error'; error: unknown };

/** 取消原因：优先用请求信号上那句可读的话（停机、切换接入方式、宿主取消）。 */
export function cancellation(request: { signal?: AbortSignal }): Error {
  const reason = request.signal?.reason as unknown;
  return reason instanceof Error ? reason : abortReason('提问已取消');
}
