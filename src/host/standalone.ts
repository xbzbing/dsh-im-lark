/**
 * 独立模式：没接「我的超级助理」时，飞书消息直接落到一个 DSH 会话。
 *
 * 两种模式互斥：接入核心时桥会先接住消息（`bridge.receive` 返回非 `unknown`），
 * 只有核心不在/开关关掉时才会走到这里。所以这里不再判断「要不要让位」，只负责
 * 把消息变成会话输入、把回合结果发回飞书。
 *
 * 命令自己解析：`/help /new /sessions /status /stop /send /trace`。不进模型，
 * 也不写进会话历史。
 */

import { randomUUID } from 'node:crypto';

import type { LarkLogger } from './lark/connection.ts';
import type { LarkInboundMessage } from './lark/types.ts';
import type { OutboundChannel } from './outbound.ts';
import type { OwnerMessageDraft } from './protocol.ts';
import type { LocalSettings } from './config.ts';
import type { DirectBindingStore, OwnerStore } from './state/direct.ts';

export type BusyMode = 'queue' | 'steer';

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string };

export interface SessionRow {
  sessionId?: unknown;
  running?: unknown;
  updatedAt?: unknown;
  projections?: { values?: Record<string, unknown> } | null;
}

/** 宿主 `sessionController` 里本模块用到的方法（结构类型）。 */
export interface StandaloneController {
  create(request: { workspaceId?: string }): Promise<{ sessionId: string }>;
  prompt(
    request: {
      requestId: string;
      sessionId: string;
      mode: BusyMode;
      content: readonly PromptPart[];
      clientTimeZone?: string;
    },
    signal: AbortSignal,
  ): Promise<{ accepted?: boolean }>;
  cancel?(request: { sessionId: string }): { accepted?: boolean } | Promise<{ accepted?: boolean }>;
  list?(request: Record<string, unknown>, signal: AbortSignal): Promise<{ items?: readonly SessionRow[] }>;
  rename?(request: { sessionId: string; title: string }): Promise<unknown>;
}

export type StandaloneCommand =
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'sessions'; index?: number }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'trace' }
  | { kind: 'send'; text: string }
  | { kind: 'unknown'; name: string };

/** 解析以 `/` 开头的文本；不是命令返回 null。 */
export function parseCommand(input: string): StandaloneCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const [head = '', ...rest] = trimmed.slice(1).split(/\s+/);
  const name = head.toLowerCase();
  const tail = rest.join(' ').trim();

  switch (name) {
    case '':
    case 'help':
      return { kind: 'help' };
    case 'new':
      return { kind: 'new' };
    case 'status':
      return { kind: 'status' };
    case 'stop':
      return { kind: 'stop' };
    case 'trace':
      return { kind: 'trace' };
    case 'send':
      return tail === '' ? { kind: 'help' } : { kind: 'send', text: tail };
    case 'sessions': {
      if (tail === '') return { kind: 'sessions' };
      const index = Number(tail);
      return Number.isInteger(index) && index > 0 ? { kind: 'sessions', index } : { kind: 'sessions' };
    }
    default:
      return { kind: 'unknown', name };
  }
}

export const HELP_TEXT = [
  '我是这个工作区的飞书入口。可用命令：',
  '',
  '`/new` 开新会话',
  '`/sessions` 查看最近会话；`/sessions 2` 切到第 2 个',
  '`/status` 当前会话与连接状态',
  '`/stop` 中止正在跑的回合',
  '`/trace` 上一条回答的模型与耗时',
  '`/send <文本>` 不经过模型，直接发一段文本',
  '`/help` 这份说明',
].join('\n');

export interface StandaloneOptions {
  outbound: OutboundChannel;
  bindings: DirectBindingStore;
  owners: OwnerStore;
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
const LIST_LIMIT = 10;

export class StandaloneChat {
  readonly #outbound: OutboundChannel;
  readonly #bindings: DirectBindingStore;
  readonly #owners: OwnerStore;
  readonly #settings: () => LocalSettings;
  readonly #controller: () => StandaloneController | null;
  readonly #workspaceId: () => string;
  readonly #logger: LarkLogger;
  readonly #now: () => number;
  readonly #ownerLabel: () => string;
  readonly #submitTimeoutMs: number;
  readonly #markDone: ((platformMessageId: string) => void) | undefined;

  #chatId = '';
  #lastUserMessageId: string | undefined;
  /**
   * 已提交、等回合结束的消息（平台 id，按提交顺序）。完成标记按这个队列对齐而不是
   * 用 `#lastUserMessageId`：排队模式下后一条先入队，用「最近一条」会给错的消息盖
   * `DONE`。回合没给回答时丢弃队头（不打假的完成标记），保持后续对齐。
   */
  readonly #pendingMessageIds: string[] = [];
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
    this.#settings = options.settings;
    this.#controller = options.controller;
    this.#workspaceId = options.workspaceId ?? (() => '');
    this.#logger = options.logger ?? {};
    this.#now = options.now ?? Date.now;
    this.#ownerLabel = options.ownerLabel ?? (() => '');
    this.#submitTimeoutMs = options.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS;
    this.#markDone = options.markDone;
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

    this.#chatId = message.chatId;
    this.#lastUserMessageId = message.messageId;

    const text = draft.text.trim();
    const command = parseCommand(text);
    if (command !== null) {
      await this.#runCommand(command);
      // 命令当场就答完了：回复发出即处理结束，补完成标记（失败的回复也一样，命令本身已处理）。
      this.#markDone?.(message.messageId);
      return;
    }

    const showNotice = await this.#submit(text, draft);
    // 提交失败的通知不是完成：只留「收到」，不盖 DONE；回答要等回合结束。
    if (showNotice !== null) await this.#reply(showNotice);
    else this.#pendingMessageIds.push(message.messageId);
  }

  /** `session/event`：跟踪绑定会话的回合，结束后把回答发回飞书。 */
  handleEvent(sessionId: string, event: unknown): void {
    const binding = this.#bindings.peek();
    if (binding === null || binding.sessionId !== sessionId) return;
    const entry = asRecord(event);
    if (entry === null) return;

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
        const pending = this.#pendingMessageIds.shift();
        if (answer === '') return;
        this.#lastTrace = { model: this.#model, durationMs: Math.max(0, this.#now() - this.#startedAt), at: this.#now() };
        // 回答送达成功才算这一轮结束；发送失败只留「收到」，不给假信号。
        void this.#reply(answer, this.#lastTrace)
          .then(() => {
            if (pending !== undefined) this.#markDone?.(pending);
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
      await this.#bindings.set({ sessionId: created.sessionId, workspaceId, title });
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

  async #runCommand(command: StandaloneCommand): Promise<void> {
    switch (command.kind) {
      case 'help':
        await this.#reply(HELP_TEXT);
        return;
      case 'new':
        await this.reset();
        await this.#reply('已开新会话，下一条消息会建一个新的。');
        return;
      case 'status':
        await this.#reply(this.#statusText());
        return;
      case 'stop': {
        const binding = this.#bindings.peek();
        const controller = this.#controller();
        if (binding === null || controller === null || typeof controller.cancel !== 'function') {
          await this.#reply('当前没有可中止的会话。');
          return;
        }
        const result = await controller.cancel({ sessionId: binding.sessionId });
        await this.#reply(result?.accepted === false ? '这一轮已经结束了。' : '已请求中止当前回合。');
        return;
      }
      case 'trace':
        await this.#reply(
          this.#lastTrace === null
            ? '还没有收到过回答。'
            : `上一条回答：模型 ${this.#lastTrace.model === '' ? '未知' : this.#lastTrace.model}，耗时 ${formatDuration(this.#lastTrace.durationMs)}。`,
        );
        return;
      case 'send':
        await this.#reply(command.text);
        return;
      case 'sessions':
        await this.#reply(await this.#sessionsText(command.index));
        return;
      default:
        await this.#reply(`不认识的命令：/${command.name}\n\n${HELP_TEXT}`);
        return;
    }
  }

  async #sessionsText(index: number | undefined): Promise<string> {
    const controller = this.#controller();
    if (controller === null || typeof controller.list !== 'function') return '宿主没有提供会话列表。';

    let rows: readonly SessionRow[];
    try {
      const list = await controller.list({ limit: LIST_LIMIT }, AbortSignal.timeout(10_000));
      rows = list.items ?? [];
    } catch (error) {
      this.#logger.warn?.('会话列表读取失败', errorText(error));
      return '会话列表读取失败。';
    }
    if (rows.length === 0) return '最近没有会话。';

    const current = this.#bindings.peek()?.sessionId;
    const lines = rows.slice(0, LIST_LIMIT).map((row, position) => {
      const id = typeof row.sessionId === 'string' ? row.sessionId : '';
      const title = sessionTitle(row) || id.slice(0, 8);
      const mark = id === current ? '（当前）' : '';
      return `${position + 1}. ${title}${mark}`;
    });

    if (index !== undefined) {
      const target = rows[index - 1];
      const id = typeof target?.sessionId === 'string' ? target.sessionId : '';
      if (target === undefined || id === '') return `没有第 ${index} 个会话。`;
      await this.#bindings.set({ sessionId: id, workspaceId: '', ...(sessionTitle(target) === '' ? {} : { title: sessionTitle(target) }) });
      return `已切到：${sessionTitle(target) || id.slice(0, 8)}`;
    }

    return ['最近的会话：', ...lines, '', '用 `/sessions <序号>` 切换。'].join('\n');
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

  async #reply(text: string, trace?: TraceRecord | null): Promise<void> {
    const settings = this.#settings();
    const footer = settings.replyStatus && trace !== undefined && trace !== null ? statusLine(trace) : '';
    const body = footer === '' ? text : `${text}\n\n---\n${footer}`;

    // 重启后事件可能先到（绑定还在、本次进程还没收到过消息）：退回主人最近一次的会话。
    const chatId = this.#chatId !== '' ? this.#chatId : (await this.#owners.get())?.chatId ?? '';
    if (chatId === '') {
      this.#logger.warn?.('独立模式回复没有目标会话，已丢弃');
      return;
    }

    const receipt = await this.#outbound.deliver({
      deliveryId: `direct-${this.#now()}-${(this.#sequence += 1)}`,
      chatId,
      text: body,
      ...(this.#lastUserMessageId === undefined ? {} : { replyTo: this.#lastUserMessageId }),
    });
    if (receipt.errorCode !== undefined) {
      this.#logger.warn?.('独立模式回复没有发出去', receipt.error ?? receipt.errorCode);
    }
  }
}

/** 文字在前、图片在后；附件在独立模式下先只给提示。 */
export function buildContent(text: string, draft: OwnerMessageDraft): PromptPart[] {
  const parts: PromptPart[] = [];
  const body = text.trim();
  if (body === '' && (draft.images ?? []).length === 0) parts.push({ type: 'text', text: '（空消息）' });
  if (body !== '') parts.push({ type: 'text', text: body });
  for (const image of draft.images ?? []) {
    parts.push({ type: 'image', mediaType: image.mediaType, data: image.data, ...(image.name === undefined ? {} : { name: image.name }) });
  }
  const fileCount = draft.files?.length ?? 0;
  if (fileCount > 0) {
    parts.push({ type: 'text', text: `（收到 ${fileCount} 个文件；独立模式暂不转发文件内容）` });
  }
  return parts;
}

/** 从 `assistant/message` 的 content 块里取文字。 */
export function textFromAssistantMessage(message: unknown): string {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    const item = asRecord(block);
    if (item !== null && item.type === 'text' && typeof item.text === 'string') text += item.text;
  }
  return text;
}

function sessionTitle(row: SessionRow): string {
  const values = row.projections?.values;
  return values !== undefined && typeof values.title === 'string' ? values.title : '';
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

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
