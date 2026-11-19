/**
 * 出站：把一段回答变成飞书消息。
 *
 * 三件事必须同时成立：
 * 1. **分条**：超过 `maxText` 或卡片体积上限就切段，切点尽量落在段落/行边界，
 *    代码块被切断时补上围栏，避免第二段变成一堆裸代码。
 * 2. **幂等**：同一个 `deliveryId` 重投不得重复发消息；`uuid` 再给平台兜一层。
 * 3. **可重试**：网络与频控失败按次数退避，并从断点续发；鉴权、超长这类
 *    重试也没用的错误直接返回，让上层决定换凭据还是缩短内容。
 *
 * 这一层不认识 `my-superagent/v1`，也不知道回答是模型写的还是命令回执——只收
 * 一段文本 + 可选媒体 + 一个会话 id。
 */

import { createHash } from 'node:crypto';

import { CARD_BODY_BYTES_MAX, MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_IMAGE_BYTES, SEND_QPS, SEND_WINDOW_MS } from '../shared/limits.ts';
import { cardBytes, cardContent, renderMarkdownCard } from './cards.ts';
import type { CardTemplate } from './cards.ts';
import type { LarkApi } from './lark/api.ts';
import type { LarkLogger } from './lark/connection.ts';
import { LarkFailure, retryDelayMs, toLarkFailure } from './lark/errors.ts';
import type { LarkFailureKind } from './lark/errors.ts';
import { RateGate } from './rate-limit.ts';

/** 回执里的错误码，取值与 `my-superagent/v1` 对齐。 */
export type OutboundErrorCode = 'window-closed' | 'rate-limited' | 'auth-expired' | 'too-long' | 'other';

export interface OutboundImage {
  bytes: Uint8Array;
  fileName: string;
}

export interface OutboundFile {
  bytes: Uint8Array;
  fileName: string;
  /** 不传按扩展名推断。 */
  fileType?: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
}

export interface OutboundInput {
  /** 幂等键。 */
  deliveryId: string;
  text: string;
  /** 回复某条消息；只有第一条消息会走 reply，后续走群发。 */
  replyTo?: string;
  images?: readonly OutboundImage[];
  files?: readonly OutboundFile[];
  /** 到期时间（毫秒）；过期不发，直接回 `window-closed`。 */
  expiresAt?: number;
  /** 卡片标题；不传则是纯内容卡。 */
  title?: string;
  template?: CardTemplate;
}

export interface OutboundReceipt {
  messageIds: string[];
  messagesSent: number;
  errorCode?: OutboundErrorCode;
  error?: string;
  /** 命中幂等表，本次没有真的发。 */
  reused?: boolean;
}

export interface OutboundChannelOptions {
  api: LarkApi;
  chatId: string;
  /** 单条字符上限；分条用。 */
  maxText: number;
  logger?: LarkLogger;
  now?: () => number;
  /** 自定义限速闸门；默认 5 次 / 1000 ms。 */
  gate?: RateGate;
  /** 单次发送的最大尝试次数（含首次），默认 3。 */
  maxAttempts?: number;
  /** 退避等待实现，测试可注入。 */
  sleep?: (ms: number) => Promise<void>;
}

interface Part {
  kind: 'card' | 'image' | 'file';
  /** 卡片正文，或图片/文件的显示名（日志用）。 */
  label: string;
  payload: string | Uint8Array;
  fileType?: OutboundFile['fileType'];
}

interface Progress {
  parts: number;
  messageIds: string[];
}

const DEFAULT_MAX_ATTEMPTS = 3;

export class OutboundChannel {
  readonly #api: LarkApi;
  readonly #chatId: string;
  readonly #maxText: number;
  readonly #logger: LarkLogger;
  readonly #now: () => number;
  readonly #gate: RateGate;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** 幂等表：只放成功（或已判定不可重试）的结果。 */
  readonly #receipts = new Map<string, OutboundReceipt>();
  /** 断点：已经发到第几段、已发出哪些 id。 */
  readonly #progress = new Map<string, Progress>();

  constructor(options: OutboundChannelOptions) {
    this.#api = options.api;
    this.#chatId = options.chatId;
    this.#maxText = Math.max(1, options.maxText);
    this.#logger = options.logger ?? {};
    this.#now = options.now ?? Date.now;
    this.#gate = options.gate ?? new RateGate({ max: SEND_QPS, windowMs: SEND_WINDOW_MS, now: this.#now });
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#sleep = options.sleep ?? sleep;
  }

  /** 交付一段回答。可重复调用：同 `deliveryId` 只会真正发一次。 */
  async deliver(input: OutboundInput): Promise<OutboundReceipt> {
    const cached = this.#receipts.get(input.deliveryId);
    if (cached !== undefined && cached.errorCode === undefined) return { ...cached, reused: true };

    if (input.expiresAt !== undefined && input.expiresAt <= this.#now()) {
      return this.#fail(input.deliveryId, 'window-closed', '交付已过期，未发送');
    }

    const parts = this.#plan(input);
    if (parts.length === 0) return this.#succeed(input.deliveryId, []);

    const progress = this.#progress.get(input.deliveryId) ?? { parts: 0, messageIds: [] };

    for (let index = progress.parts; index < parts.length; index += 1) {
      const part = parts[index]!;
      try {
        // 只有第一条回复原消息：后面的段落再 reply 会变成一串重复的引用。
        const messageId = await this.#sendWithRetry(part, index, index === 0 ? input.replyTo : undefined, input.deliveryId);
        progress.messageIds.push(messageId);
        progress.parts = index + 1;
        this.#progress.set(input.deliveryId, progress);
      } catch (error) {
        const failure = toLarkFailure(error);
        const code = errorCodeOf(failure.kind);
        this.#logger.warn?.('出站发送失败', `${failure.kind} ${failure.message}`);
        // 已发出的段落保留在断点里：下次同 id 重投从下一段续发，不重复。
        this.#progress.set(input.deliveryId, progress);
        return {
          messageIds: [...progress.messageIds],
          messagesSent: progress.messageIds.length,
          errorCode: code,
          error: failure.message,
        };
      }
    }

    return this.#succeed(input.deliveryId, progress.messageIds);
  }

  /** 该会话已发出的条数（面板/测试用）。 */
  get receipts(): ReadonlyMap<string, OutboundReceipt> {
    return this.#receipts;
  }

  /** 把回答拆成待发分段（纯函数的好处：测试不用起假 API）。 */
  #plan(input: OutboundInput): Part[] {
    // 模板参数只在这里合并一次：下面的切分要把「同一张卡的渲染」当成纯函数反复调。
    const render = (text: string): Record<string, unknown> =>
      renderMarkdownCard(text, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.template === undefined ? {} : { template: input.template }),
      });

    const parts: Part[] = [];
    for (const segment of splitMarkdown(input.text, this.#maxText)) {
      // 字符没超但字节超了（表情、多字节字符多）：继续对半切，直到装得下。
      for (const piece of shrinkToCardLimit(segment, render)) {
        parts.push({ kind: 'card', label: '回答', payload: cardContent(render(piece)) });
      }
    }

    for (const image of input.images ?? []) {
      parts.push({ kind: 'image', label: image.fileName, payload: image.bytes });
    }
    for (const file of input.files ?? []) {
      parts.push({ kind: 'file', label: file.fileName, payload: file.bytes, fileType: file.fileType });
    }
    return parts;
  }

  async #sendWithRetry(part: Part, index: number, replyTo: string | undefined, deliveryId: string): Promise<string> {
    const uuid = idempotencyKey(deliveryId, index);
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        await this.#gate.acquire();
        return await this.#sendOnce(part, replyTo, uuid);
      } catch (error) {
        lastError = error;
        const failure = toLarkFailure(error);
        if (!failure.retriable || attempt === this.#maxAttempts) throw failure;
        const delay = retryDelayMs(failure, attempt);
        this.#logger.debug?.('出站重试', `${failure.kind} ${delay}ms 第 ${attempt} 次`);
        await this.#sleep(delay);
      }
    }
    throw lastError;
  }

  async #sendOnce(part: Part, replyTo: string | undefined, uuid: string): Promise<string> {
    if (part.kind === 'card') {
      const content = part.payload as string;
      const result =
        replyTo === undefined
          ? await this.#api.createMessage({ chatId: this.#chatId, msgType: 'interactive', content, options: { uuid } })
          : await this.#api.replyMessage({ messageId: replyTo, msgType: 'interactive', content, options: { uuid } });
      return result.messageId;
    }

    if (part.kind === 'image') {
      const bytes = part.payload as Uint8Array;
      if (bytes.byteLength > MAX_UPLOAD_IMAGE_BYTES) {
        throw new LarkFailure({ kind: 'too-long', message: `图片超过 ${Math.round(MAX_UPLOAD_IMAGE_BYTES / 1024 / 1024)} MB：${part.label}` });
      }
      const uploaded = await this.#api.uploadImage({ bytes, fileName: part.label });
      const result = await this.#api.createMessage({
        chatId: this.#chatId,
        msgType: 'image',
        content: JSON.stringify({ image_key: uploaded.imageKey }),
        options: { uuid },
      });
      return result.messageId;
    }

    const bytes = part.payload as Uint8Array;
    if (bytes.byteLength > MAX_UPLOAD_FILE_BYTES) {
      throw new LarkFailure({ kind: 'too-long', message: `文件超过 ${Math.round(MAX_UPLOAD_FILE_BYTES / 1024 / 1024)} MB：${part.label}` });
    }
    const uploaded = await this.#api.uploadFile({
      bytes,
      fileName: part.label,
      fileType: part.fileType ?? fileTypeOf(part.label),
    });
    const result = await this.#api.createMessage({
      chatId: this.#chatId,
      msgType: 'file',
      content: JSON.stringify({ file_key: uploaded.fileKey }),
      options: { uuid },
    });
    return result.messageId;
  }

  #succeed(deliveryId: string, messageIds: string[]): OutboundReceipt {
    const receipt: OutboundReceipt = { messageIds: [...messageIds], messagesSent: messageIds.length };
    this.#receipts.set(deliveryId, receipt);
    this.#progress.delete(deliveryId);
    return receipt;
  }

  #fail(deliveryId: string, code: OutboundErrorCode, error: string): OutboundReceipt {
    const receipt: OutboundReceipt = { messageIds: [], messagesSent: 0, errorCode: code, error };
    this.#receipts.set(deliveryId, receipt);
    return receipt;
  }
}

/** 失败类型 → 协议错误码。 */
export function errorCodeOf(kind: LarkFailureKind): OutboundErrorCode {
  switch (kind) {
    case 'rate-limited':
      return 'rate-limited';
    case 'auth':
      return 'auth-expired';
    case 'too-long':
      return 'too-long';
    case 'gone':
      return 'window-closed';
    default:
      return 'other';
  }
}

/**
 * 按字符上限切分 Markdown。
 *
 * 切点优先级：段落（空行）→ 行 → 硬切。代码块按围栏状态识别，跨段时补围栏，
 * 这样每一段单独渲染也是合法的 Markdown。
 */
export function splitMarkdown(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized === '') return [];
  if (normalized.length <= limit) return [normalized];

  const segments: string[] = [];
  let current = '';

  for (const block of markdownBlocks(normalized)) {
    const pieces = block.length <= limit ? [block] : hardSplit(block, limit);
    for (const piece of pieces) {
      if (current === '') {
        current = piece;
      } else if (current.length + 2 + piece.length <= limit) {
        current = `${current}\n\n${piece}`;
      } else {
        segments.push(current);
        current = piece;
      }
    }
  }
  if (current !== '') segments.push(current);
  return segments;
}

/**
 * 按「空行且不在代码块内」切块。
 *
 * 不能直接 `split(/\n{2,}/)`：代码块里本来就有空行，切了会把一块代码劈成两段。
 */
function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  for (const line of text.split('\n')) {
    const marker = fenceMarker(line);
    if (marker !== null) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0]) fence = null;
    }

    if (line.trim() === '' && fence === null) {
      if (buffer.length > 0) {
        blocks.push(buffer.join('\n'));
        buffer = [];
      }
      continue;
    }
    buffer.push(line);
  }
  if (buffer.length > 0) blocks.push(buffer.join('\n'));
  return blocks;
}

/** 单块硬切：优先在行边界切，切口在代码块里时补上围栏。 */
function hardSplit(block: string, limit: number): string[] {
  const out: string[] = [];
  let rest = block;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    let head = rest.slice(0, cut);
    const fence = openFence(head);
    if (fence !== null) head = `${head}\n${fence}`;
    out.push(head);

    rest = rest.slice(cut).replace(/^\n+/, '');
    if (fence !== null) rest = `${fence}\n${rest}`;
  }
  if (rest !== '') out.push(rest);
  return out;
}

/** 返回未闭合的围栏标记（如 ```），没有则 null。 */
function openFence(text: string): string | null {
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = fenceMarker(line);
    if (marker === null) continue;
    fence = fence === null ? marker : marker[0] === fence[0] ? null : fence;
  }
  return fence;
}

function fenceMarker(line: string): string | null {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
  return match === null ? null : match[1]!;
}

/**
 * 卡片字节超限时的兜底切分。
 *
 * 返回的每一段都保证单卡装得下。`fits` 由调用方给（因为它依赖卡片模板），
 * 这样本函数不用知道卡片长什么样。
 */
export function shrinkToCardLimit(segment: string, render: (text: string) => unknown): string[] {
  const fits = (text: string): boolean => cardBytes(render(text)) <= CARD_BODY_BYTES_MAX;
  if (fits(segment)) return [segment];

  const out: string[] = [];
  const queue = [segment];
  while (queue.length > 0) {
    const piece = queue.shift()!;
    if (fits(piece)) {
      out.push(piece);
      continue;
    }
    const halves = hardSplit(piece, Math.max(200, Math.floor(piece.length / 2)));
    if (halves.length <= 1) {
      // 已经切无可切：交给发送端按 too-long 处理，别在这里死循环。
      out.push(piece);
      continue;
    }
    queue.unshift(...halves);
  }
  return out;
}

/** 平台 uuid 上限 50 字符；用交付 id + 段号哈希，稳定且不泄漏内部 id。 */
export function idempotencyKey(deliveryId: string, index: number): string {
  const digest = createHash('sha1').update(`${deliveryId}#${index}`).digest('hex');
  return `lark-${digest.slice(0, 20)}`;
}

/** 按扩展名猜 `file_type`；不确定走 `stream`。 */
export function fileTypeOf(fileName: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.doc') || lower.endsWith('.docx')) return 'doc';
  if (lower.endsWith('.xls') || lower.endsWith('.xlsx') || lower.endsWith('.csv')) return 'xls';
  if (lower.endsWith('.ppt') || lower.endsWith('.pptx')) return 'ppt';
  if (lower.endsWith('.mp4') || lower.endsWith('.mov')) return 'mp4';
  if (lower.endsWith('.opus') || lower.endsWith('.ogg') || lower.endsWith('.mp3')) return 'opus';
  return 'stream';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
