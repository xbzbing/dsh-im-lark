/**
 * 独立模式：没接「我的超级助理」时，飞书消息直接落到一个 DSH 会话。
 *
 * 两种模式互斥：接入核心时桥会先接住消息（`bridge.receive` 返回非 `unknown`），
 * 只有核心不在/开关关掉时才会走到这里。所以这里不再判断「要不要让位」，只负责
 * 把消息变成会话输入、把回合结果发回飞书。
 *
 * 命令自己解析：`/help /new /sessions /switch /status /stop /send /trace`。不进
 * 模型，也不写进会话历史。
 */

import { randomUUID } from 'node:crypto';

import { DoneAlign } from './done-align.ts';
import { buildContent } from './prompt-content.ts';
import { markLabel, sessionLabel } from './session-list.ts';
import { SendWatcher } from './session-watch.ts';
import { asRecord, textFromAssistantMessage } from './session-text.ts';
import { handleSendCommand } from './standalone-send.ts';
import { handleSessionsCommand } from './standalone-sessions.ts';
import { handleSwitchCommand } from './standalone-switch.ts';
import type { StandaloneCommand } from './standalone-command.ts';
import { HELP_TEXT, parseCommand } from './standalone-command.ts';
import type { BusyMode, StandaloneController } from './standalone-types.ts';
import type { LarkLogger } from './lark/connection.ts';
import type { LarkInboundMessage } from './lark/types.ts';
import type { OutboundChannel } from './outbound.ts';
import type { OwnerMessageDraft } from './protocol.ts';
import type { LocalSettings } from './config.ts';
import type { DirectBindingStore, OwnerStore } from './state/direct.ts';
import type { ListingStore } from './state/listing.ts';

export type { BusyMode, PromptPart, StandaloneController } from './standalone-types.ts';
export { buildContent } from './prompt-content.ts';

export interface StandaloneOptions {
  outbound: OutboundChannel;
  bindings: DirectBindingStore;
  owners: OwnerStore;
  /** `/sessions` 的序号快照（落盘在 `sessions.json`）。 */
  listing: ListingStore;
  settings: () => LocalSettings;
  controller: () => StandaloneController | null;
  /** 插件自动创建的默认工作区 id；空串表示用宿主默认位置。 */
  workspaceId?: () => string;
  logger?: LarkLogger;
  now?: () => number;
  /** 建会话时标题里带的主人标识（App ID 尾号）。 */
  ownerLabel?: () => string;
  /** 提交超时：只约束「受理前」的等待。 */
  submitTimeoutMs?: number;
  /** `/send` 等回答的上限（默认 30 分钟；测试可调小）。 */
  sendTimeoutMs?: number;
  /** 测试注入的定时器（生产用 `setTimeout().unref()`）。 */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * 这一轮真正结束（回答已发出）或命令处理完后，给触发它的原消息补 `DONE`
   * （入参是平台消息 id）。是否打表情（面板开关）由注入方判断。
   */
  markDone?: (platformMessageId: string) => void;
}

export interface StandaloneStatus {
  bound: boolean;
  sessionId?: string;
  running: boolean;
  available: boolean;
  mode: BusyMode;
}

interface TraceRecord {
  model: string;
  durationMs: number;
  at: number;
}

const SUBMIT_TIMEOUT_MS = 30_000;

export class StandaloneChat {
  readonly #outbound: OutboundChannel;
  readonly #bindings: DirectBindingStore;
  readonly #owners: OwnerStore;
  readonly #listing: ListingStore;
  readonly #settings: () => LocalSettings;
  readonly #controller: () => StandaloneController | null;
  readonly #workspaceId: () => string;
  readonly #logger: LarkLogger;
  readonly #now: () => number;
  readonly #ownerLabel: () => string;
  readonly #submitTimeoutMs: number;
  readonly #markDone: ((platformMessageId: string) => void) | undefined;
  readonly #watcher: SendWatcher;

  #chatId = '';
  #lastUserMessageId: string | undefined;
  /**
   * 已提交、等回合结束的消息（按提交顺序对齐）。
   * 规则与宿主回合语义见 `done-align.ts`：不用 `#lastUserMessageId` 结算，那会把
   * 完成标记盖到没被回答的消息上。
   */
  readonly #align = new DoneAlign();
  #running = false;
  #answer = '';
  #startedAt = 0;
  #model = '';
  #lastTrace: TraceRecord | null = null;
  #sequence = 0;
  #creating: Promise<string> | null = null;

  constructor(options: StandaloneOptions) {
    this.#outbound = options.outbound;
    this.#bindings = options.bindings;
    this.#owners = options.owners;
    this.#listing = options.listing;
    this.#settings = options.settings;
    this.#controller = options.controller;
    this.#workspaceId = options.workspaceId ?? (() => '');
    this.#logger = options.logger ?? {};
    this.#now = options.now ?? Date.now;
    this.#ownerLabel = options.ownerLabel ?? (() => '');
    this.#submitTimeoutMs = options.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS;
    this.#markDone = options.markDone;
    this.#watcher = new SendWatcher({
      deliver: (target, text) => this.#deliverTo(target.chatId, text, target.replyTo),
      ...(options.markDone === undefined ? {} : { onDelivered: options.markDone }),
      now: this.#now,
      logger: this.#logger,
      ...(options.sendTimeoutMs === undefined ? {} : { timeoutMs: options.sendTimeoutMs }),
      ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
      ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
    });
  }

  status(): StandaloneStatus {
    const binding = this.#bindings.peek();
    return {
      bound: binding !== null,
      ...(binding === null ? {} : { sessionId: binding.sessionId }),
      running: this.#running,
      available: this.#controller() !== null,
      mode: this.#busyMode(),
    };
  }

  /** 入站消息入口：认主人、认命令，其余交给绑定的会话。 */
  async handleInbound(message: LarkInboundMessage, draft: OwnerMessageDraft): Promise<void> {
    const owner = await this.#resolveOwner(message);
    if (owner === false) {
      this.#logger.debug?.('独立模式：非主人消息，忽略', message.senderOpenId);
      return;
    }

    // 先把绑定读进缓存：回复前缀按 `peek()` 判断，命令回执也要能立刻带上会话名。
    await this.#bindings.get();

    this.#chatId = message.chatId;
    this.#lastUserMessageId = message.messageId;

    const text = draft.text.trim();
    const command = parseCommand(text);
    if (command !== null) {
      // `/send` 要等目标会话那一轮结束才算处理完；其余命令当场就答完了。
      const awaiting = await this.#runCommand(command, message.messageId, draft);
      if (!awaiting) this.#markDone?.(message.messageId);
      return;
    }

    const showNotice = await this.#submit(text, draft);
    // 提交失败的通知不是完成：只留「收到」，不盖 DONE；回答要等回合结束。
    if (showNotice !== null) await this.#reply(showNotice);
    else this.#align.push(message.messageId, this.#busyMode());
  }

  /** `session/event`：`/send` 的目标会话与绑定会话各走一条路。 */
  handleEvent(sessionId: string, event: unknown): void {
    this.#watcher.handleEvent(sessionId, event);

    const entry = asRecord(event);
    if (entry === null) return;

    const binding = this.#bindings.peek();

    // 标题事件连前台会话一起跟：切走之后前台改名，回来时前缀才是新的。
    // 绑定已加载时先同步过滤，避免无关会话的标题事件也排进写队列。
    if (entry.type === 'session/title') {
      const title = asRecord(entry.data)?.title;
      if (typeof title !== 'string' || title.trim() === '') return;
      if (binding !== null && binding.sessionId !== sessionId && binding.frontSessionId !== sessionId) return;
      void this.#bindings.setTitle(title.trim(), sessionId).catch(() => undefined);
      return;
    }

    if (binding === null || binding.sessionId !== sessionId) return;

    switch (entry.type) {
      case 'turn/start':
        this.#running = true;
        this.#answer = '';
        this.#startedAt = this.#now();
        return;
      case 'model/selection': {
        const data = asRecord(entry.data);
        const model = typeof data?.model === 'string' ? data.model : '';
        if (model !== '') this.#model = model;
        return;
      }
      case 'assistant/message': {
        const message = asRecord(entry.data)?.message;
        const text = textFromAssistantMessage(message);
        if (text.trim() !== '') this.#answer = text;
        return;
      }
      case 'turn/end': {
        this.#running = false;
        const answer = this.#answer.trim();
        this.#answer = '';
        // 无论有没有回答都结算：这一轮已经消耗掉这些消息，留在队里只会被下一轮错认。
        const settled = this.#align.settle();
        if (answer === '') return;
        this.#lastTrace = { model: this.#model, durationMs: Math.max(0, this.#now() - this.#startedAt), at: this.#now() };
        // 回答真正发出去才算这一轮结束；发送失败（含没有目标会话）只留「收到」，不给假信号。
        void this.#reply(answer, this.#lastTrace)
          .then((delivered) => {
            if (!delivered) return;
            for (const messageId of settled) this.#markDone?.(messageId);
          })
          .catch((error: unknown) => {
            this.#logger.warn?.('独立模式回复失败', errorText(error));
          });
        return;
      }
      default:
        return;
    }
  }

  async reset(): Promise<void> {
    this.#running = false;
    this.#answer = '';
    // 旧会话的回合结束会被会话校验丢弃，残留的待结算条目只会被下一轮错认。
    this.#align.clear();
    await this.#bindings.clear();
  }

  /** 主动发一段文本（CLI 与命令共用）；返回 `deliveryId` 为空的失败原因。 */
  async sendText(text: string): Promise<{ ok: boolean; error?: string }> {
    const owner = await this.#owners.get();
    if (owner === null || owner.chatId === '') return { ok: false, error: '还没有主人：先在飞书里给机器人发一条私聊消息' };
    const receipt = await this.#outbound.deliver({ deliveryId: `send-${this.#now()}-${(this.#sequence += 1)}`, chatId: owner.chatId, text });
    return receipt.errorCode === undefined ? { ok: true } : { ok: false, error: receipt.error ?? receipt.errorCode };
  }

  /** 第一条私聊消息认主人；已有人则只放行本人。 */
  async #resolveOwner(message: LarkInboundMessage): Promise<boolean> {
    const existing = await this.#owners.get();
    if (existing !== null) {
      if (message.senderOpenId !== existing.openId) return false;
      // 只把单聊记成「主人最近活跃的会话」：在群里说话不该让主动发送改投到群里。
      if (message.chatType === 'p2p' && message.chatId !== existing.chatId) {
        await this.#owners.rememberChat(message.chatId);
      }
      return true;
    }
    if (message.chatType !== 'p2p') return false;
    await this.#owners.claim(message.senderOpenId, message.chatId);
    this.#logger.info?.('独立模式：已把第一位私聊用户认作主人', message.senderOpenId);
    return true;
  }

  async #submit(text: string, draft: OwnerMessageDraft): Promise<string | null> {
    const controller = this.#controller();
    if (controller === null) return '独立模式不可用：宿主没有会话控制器。消息没有进会话。';

    try {
      const sessionId = await this.#ensureSession(controller);
      const content = buildContent(text, draft);
      const mode = this.#busyMode();
      const accepted = await controller.prompt(
        { requestId: randomUUID(), sessionId, mode, content, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        AbortSignal.timeout(this.#submitTimeoutMs),
      );
      if (accepted.accepted === false) return '会话没有接受这条消息（可能已停止或已关闭）。';
      return null;
    } catch (error) {
      this.#logger.warn?.('独立模式提交失败', errorText(error));
      return '提交失败，消息没有进会话。稍后再试。';
    }
  }

  async #ensureSession(controller: StandaloneController): Promise<string> {
    const existing = await this.#bindings.get();
    if (existing !== null) return existing.sessionId;
    if (this.#creating !== null) return this.#creating;

    const task = (async () => {
      // 面板选过工作区就用它；没选过用插件自动创建的默认工作区；都没有才交给宿主。
      const configured = this.#settings().directWorkspaceId.trim();
      const workspaceId = configured !== '' ? configured : this.#workspaceId().trim();
      const created = await controller.create(workspaceId === '' ? {} : { workspaceId });
      const title = `飞书${this.#ownerLabel() === '' ? '' : ` · ${this.#ownerLabel()}`}`;
      await this.#bindings.set({
        sessionId: created.sessionId,
        workspaceId,
        title,
        frontSessionId: created.sessionId,
        frontTitle: title,
      });
      if (typeof controller.rename === 'function') {
        void Promise.resolve(controller.rename({ sessionId: created.sessionId, title })).catch(() => undefined);
      }
      return created.sessionId;
    })().finally(() => {
      this.#creating = null;
    });

    this.#creating = task;
    return task;
  }

  /** 执行一条命令；返回 `true` 表示还有一轮回答在路上（先别补 `DONE`）。 */
  async #runCommand(command: StandaloneCommand, messageId: string, draft: OwnerMessageDraft): Promise<boolean> {
    switch (command.kind) {
      case 'help':
        await this.#reply(HELP_TEXT);
        return false;
      case 'new':
        await this.reset();
        await this.#reply('已开新会话，下一条消息会建一个新的。');
        return false;
      case 'status':
        await this.#reply(this.#statusText());
        return false;
      case 'stop': {
        const binding = this.#bindings.peek();
        const controller = this.#controller();
        if (binding === null || controller === null || typeof controller.cancel !== 'function') {
          await this.#reply('当前没有可中止的会话。');
          return false;
        }
        const result = await controller.cancel({ sessionId: binding.sessionId });
        await this.#reply(result?.accepted === false ? '这一轮已经结束了。' : '已请求中止当前回合。');
        return false;
      }
      case 'trace':
        await this.#reply(
          this.#lastTrace === null
            ? '还没有收到过回答。'
            : `上一条回答：模型 ${this.#lastTrace.model === '' ? '未知' : this.#lastTrace.model}，耗时 ${formatDuration(this.#lastTrace.durationMs)}。`,
        );
        return false;
      case 'send':
        return handleSendCommand(command, messageId, draft, {
          controller: () => this.#controller(),
          listing: this.#listing,
          bindings: this.#bindings,
          watcher: this.#watcher,
          chatId: this.#chatId,
          submitTimeoutMs: this.#submitTimeoutMs,
          logger: this.#logger,
          submitCurrent: (text, value) => this.#submit(text, value),
          pushAlign: (id) => this.#align.push(id, this.#busyMode()),
          reply: (text) => this.#reply(text),
        });
      case 'sessions':
        await handleSessionsCommand(command.page, {
          controller: () => this.#controller(),
          listing: this.#listing,
          bindings: this.#bindings,
          reply: (text) => this.#reply(text),
        });
        return false;
      case 'switch':
        await handleSwitchCommand(command.ref, {
          controller: () => this.#controller(),
          listing: this.#listing,
          bindings: this.#bindings,
          watcher: this.#watcher,
          reply: (text) => this.#reply(text),
          onSwitched: () => {
            this.#running = false;
            this.#answer = '';
            this.#align.clear();
          },
        });
        return false;
      default:
        await this.#reply(`不认识的命令：/${command.name}\n\n${HELP_TEXT}`);
        return false;
    }
  }

  #statusText(): string {
    const binding = this.#bindings.peek();
    const mode = this.#busyMode();
    return [
      '独立模式',
      '',
      `会话：${binding === null ? '还没有（发一条消息就会建）' : binding.title ?? binding.sessionId}`,
      `运行中：${this.#running ? '是' : '否'}`,
      `回合提交：${mode === 'queue' ? '排队' : '插话'}`,
      `控制器：${this.#controller() === null ? '不可用' : '就绪'}`,
    ].join('\n');
  }

  #busyMode(): BusyMode {
    return this.#settings().directBusyMode === 'queue' ? 'queue' : 'steer';
  }

  /** 发一段文本；返回是否真的发出去了（没有目标会话或平台报错都算没送到）。 */
  async #reply(text: string, trace?: TraceRecord | null): Promise<boolean> {
    const settings = this.#settings();
    const footer = settings.replyStatus && trace !== undefined && trace !== null ? statusLine(trace) : '';
    const body = footer === '' ? text : `${text}\n\n---\n${footer}`;

    // 重启后事件可能先到（绑定还在、本次进程还没收到过消息）：退回主人最近一次的会话。
    const chatId = this.#chatId !== '' ? this.#chatId : (await this.#owners.get())?.chatId ?? '';
    return this.#deliverTo(chatId, this.#withSessionMark(body), this.#lastUserMessageId);
  }

  /** `/switch` 过来的会话：每条回复前标出会话名，一眼看出在跟哪个会话说话。 */
  #withSessionMark(body: string): string {
    const binding = this.#bindings.peek();
    if (binding === null || binding.switched !== true) return body;
    return `**${markLabel(sessionLabel(binding.title))}>**\n\n${body}`;
  }

  /** 发到指定会话；`/send` 的回答要回到发命令的那个聊天，不能跟着当前会话走。 */
  async #deliverTo(chatId: string, text: string, replyTo?: string): Promise<boolean> {
    if (chatId === '') {
      this.#logger.warn?.('独立模式回复没有目标会话，已丢弃');
      return false;
    }

    const receipt = await this.#outbound.deliver({
      deliveryId: `direct-${this.#now()}-${(this.#sequence += 1)}`,
      chatId,
      text,
      ...(replyTo === undefined ? {} : { replyTo }),
    });
    if (receipt.errorCode !== undefined) {
      this.#logger.warn?.('独立模式回复没有发出去', receipt.error ?? receipt.errorCode);
      return false;
    }
    return true;
  }

  /** 停机：收掉 `/send` 的等待定时器。 */
  stop(): void {
    this.#watcher.stop();
  }

  /** 等 `/send` 的推送与绑定写入落盘（测试与停机对齐用）。 */
  async drain(): Promise<void> {
    await this.#watcher.drain();
    await this.#bindings.drain();
  }
}

function statusLine(trace: TraceRecord): string {
  const parts = [`耗时 ${formatDuration(trace.durationMs)}`];
  if (trace.model !== '') parts.unshift(`模型 ${trace.model}`);
  return `_${parts.join(' · ')}_`;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} 秒`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
