/**
 * 入站流水线：事件 → 去重 → 下载媒体 → 交核心。
 *
 * 事件回调必须在 **3 秒**内返回，所以 `handleMessage` / `handleCardAction` 只做
 * 解析与去重，真正的活（下载、调核心、改卡片）进串行队列。串行是有意的：同一
 * 个会话里的消息要按到达顺序交给核心，并发反而会让「先问后答」错位。
 *
 * 媒体只为主人下载：核心声明了 `owner-images` / `owner-files` 才带字节，否则只
 * 保留文字，避免为一个没接核心的部署白白拉几十兆。
 */

import { MAX_FILE_BYTES, MAX_FILES_BYTES, MAX_IMAGE_BYTES, OWNER_FILES_MAX, OWNER_IMAGES_MAX } from '../shared/limits.ts';
import type { LarkApi } from './lark/api.ts';
import type { LarkLogger } from './lark/connection.ts';
import type { LarkInboundMessage } from './lark/types.ts';
import type { InboundBody, InboundFileRef, InboundImageRef } from './inbound.ts';
import { parseCardAction, parseMessageEvent } from './inbound.ts';
import type { LarkBridge } from './bridge.ts';
import type { AcceptResult, OwnerFile, OwnerImage, OwnerMessageDraft } from './protocol.ts';
import { SeenStore } from './state/seen.ts';

const TEXT_MAX = 20_000;
const KNOWN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface InboundPipelineOptions {
  api: LarkApi;
  bridge: LarkBridge;
  logger?: LarkLogger;
  seen?: SeenStore;
  /** 收到消息时打「正在处理」表情；默认开。 */
  typing?: boolean;
  /** 机器人自己的 open_id：用来区分 @我 与 @别人。 */
  botOpenId?: () => string | undefined;
  /** 主人 open_id；已知时非主人消息直接忽略。 */
  ownerOpenId?: () => string | undefined;
  /** 核心声明的可选能力，决定要不要下载图片/文件。 */
  features?: () => readonly string[];
  now?: () => number;
  /** 没有核心时的去处（独立模式）；M5 接入。 */
  fallback?: (message: LarkInboundMessage, body: InboundBody) => Promise<void>;
}

export class InboundPipeline {
  readonly #api: LarkApi;
  readonly #bridge: LarkBridge;
  readonly #logger: LarkLogger;
  readonly #seen: SeenStore;
  readonly #typing: boolean;
  readonly #botOpenId: () => string | undefined;
  readonly #ownerOpenId: () => string | undefined;
  readonly #features: () => readonly string[];
  readonly #now: () => number;
  readonly #fallback: InboundPipelineOptions['fallback'];
  #chain: Promise<void> = Promise.resolve();

  constructor(options: InboundPipelineOptions) {
    this.#api = options.api;
    this.#bridge = options.bridge;
    this.#logger = options.logger ?? {};
    this.#seen = options.seen ?? new SeenStore();
    this.#typing = options.typing ?? true;
    this.#botOpenId = options.botOpenId ?? (() => undefined);
    this.#ownerOpenId = options.ownerOpenId ?? (() => undefined);
    this.#features = options.features ?? (() => []);
    this.#now = options.now ?? Date.now;
    this.#fallback = options.fallback;
  }

  /** 事件入口：同步返回，处理进队列。 */
  handleMessage(envelope: unknown): void {
    const parsed = parseMessageEvent(envelope, { botOpenId: this.#botOpenId() });
    if (parsed.kind === 'ignored') {
      this.#logger.debug?.('入站事件忽略', parsed.reason);
      return;
    }

    const { message, body } = parsed;
    const owner = this.#ownerOpenId();
    if (owner !== undefined && owner !== '' && message.senderOpenId !== owner) {
      this.#logger.debug?.('非主人消息，忽略', message.senderOpenId);
      return;
    }

    // 去重按 message_id（官方明确不要用 event_id）。
    if (!this.#seen.claim(`${message.chatId}:${message.messageId}`)) {
      this.#logger.debug?.('重复投递，忽略', message.messageId);
      return;
    }

    this.#enqueue(() => this.#processMessage(message, body));
  }

  /** 卡片回调入口：同样只解析与去重，作答进队列。 */
  handleCardAction(envelope: unknown): void {
    const action = parseCardAction(envelope);
    if (action === null) {
      this.#logger.debug?.('卡片回调缺少必要字段');
      return;
    }

    const owner = this.#ownerOpenId();
    if (owner !== undefined && owner !== '' && action.operatorOpenId !== owner) {
      this.#logger.debug?.('非主人卡片回调，忽略', action.operatorOpenId);
      return;
    }

    const key = `card:${action.eventId || `${action.messageId}:${JSON.stringify(action.value)}`}`;
    if (!this.#seen.claim(key)) return;

    this.#enqueue(async () => {
      const result = await this.#bridge.applyCardAction(action);
      if (!result.accepted && result.reason !== 'settled') {
        this.#logger.debug?.('卡片作答未被接受', `${result.reason} ${result.detail ?? ''}`);
      }
    });
  }

  /** 等队列清空（测试与停机用）。 */
  drain(): Promise<void> {
    return this.#chain;
  }

  #enqueue(work: () => Promise<void>): void {
    this.#chain = this.#chain.then(work).catch((error: unknown) => {
      this.#logger.warn?.('入站处理失败', error instanceof Error ? error.message : String(error));
    });
  }

  async #processMessage(message: LarkInboundMessage, body: InboundBody): Promise<void> {
    const reactionId = this.#typing ? await this.#addTyping(message.messageId) : undefined;
    try {
      const draft = await this.#toDraft(message, body);
      if (draft === null) return;

      this.#bridge.recordInbound(message.messageId);
      const result: AcceptResult = await this.#bridge.receive(draft);
      if (!result.accepted && result.reason === 'unknown' && this.#fallback !== undefined) {
        await this.#fallback(message, body);
      } else if (!result.accepted) {
        this.#logger.debug?.('消息未被核心接受', `${result.reason} ${result.detail ?? ''}`);
      }
    } finally {
      if (reactionId !== undefined) await this.#removeTyping(message.messageId, reactionId);
    }
  }

  /** 事件 → 协议草稿；媒体下载失败时降级成文字说明，不让整条消息丢掉。 */
  async #toDraft(message: LarkInboundMessage, body: InboundBody): Promise<OwnerMessageDraft | null> {
    const notes: string[] = [];
    let text = body.text;
    if (body.unsupported !== undefined) {
      text = `（收到一条暂不支持的消息类型：${body.unsupported}）`;
    }

    const features = this.#features();
    const canImages = features.includes('owner-images');
    const canFiles = features.includes('owner-files');
    if (!canImages && body.images.length > 0) notes.push('（收到图片，但当前未开启图片接收）');
    if (!canFiles && body.files.length > 0) notes.push('（收到文件，但当前未开启文件接收）');

    const images = canImages ? await this.#downloadImages(message, body.images, notes) : [];
    const files = canFiles ? await this.#downloadFiles(message, body.files, notes) : [];
    if (notes.length > 0) text = [text, ...notes].filter((part) => part !== '').join('\n\n');

    if (text === '' && images.length === 0 && files.length === 0) return null;

    return {
      messageId: `${message.chatId}:${message.messageId}`,
      sender: message.senderOpenId,
      text: text.slice(0, TEXT_MAX),
      at: message.createTime > 0 ? message.createTime : this.#now(),
      ...(message.parentId === undefined ? {} : { replyTo: message.parentId }),
      platformMessageId: message.messageId,
      ...(images.length === 0 ? {} : { images }),
      ...(files.length === 0 ? {} : { files }),
    };
  }

  async #downloadImages(message: LarkInboundMessage, refs: readonly InboundImageRef[], notes: string[]): Promise<OwnerImage[]> {
    const images: OwnerImage[] = [];
    for (const ref of refs.slice(0, OWNER_IMAGES_MAX)) {
      try {
        const resource = await this.#api.downloadResource({
          messageId: message.messageId,
          fileKey: ref.imageKey,
          type: 'image',
        });
        if (resource.bytes.byteLength > MAX_IMAGE_BYTES) {
          notes.push('（有一张图片超过 10 MB，未能接收）');
          continue;
        }
        const mediaType = sniffImageType(resource.bytes, resource.contentType);
        if (mediaType === null) {
          notes.push('（有一张图片格式不受支持，未能接收）');
          continue;
        }
        images.push({
          mediaType,
          data: Buffer.from(resource.bytes).toString('base64'),
          name: `图片.${extensionOf(mediaType)}`,
        });
      } catch (error) {
        this.#logger.warn?.('图片下载失败', error instanceof Error ? error.message : String(error));
        notes.push('（有一张图片未能下载）');
      }
    }
    return images;
  }

  async #downloadFiles(message: LarkInboundMessage, refs: readonly InboundFileRef[], notes: string[]): Promise<OwnerFile[]> {
    const files: OwnerFile[] = [];
    let total = 0;

    for (const ref of refs.slice(0, OWNER_FILES_MAX)) {
      try {
        const resource = await this.#api.downloadResource({
          messageId: message.messageId,
          fileKey: ref.fileKey,
          type: 'file',
        });
        if (resource.bytes.byteLength > MAX_FILE_BYTES || total + resource.bytes.byteLength > MAX_FILES_BYTES) {
          notes.push(`（${ref.fileName} 超过大小上限，未能接收）`);
          continue;
        }
        total += resource.bytes.byteLength;
        files.push({
          name: sanitizeFileName(ref.fileName),
          ...(mediaTypeOfName(ref.fileName) === undefined ? {} : { mediaType: mediaTypeOfName(ref.fileName) }),
          data: Buffer.from(resource.bytes).toString('base64'),
        });
      } catch (error) {
        this.#logger.warn?.('文件下载失败', error instanceof Error ? error.message : String(error));
        notes.push(`（${ref.fileName} 未能下载）`);
      }
    }
    return files;
  }

  async #addTyping(messageId: string): Promise<string | undefined> {
    try {
      const result = await this.#api.addReaction({ messageId, emojiType: 'Typing' });
      return result.reactionId;
    } catch {
      // 表情是否可用随租户配置变化，失败就当作没有输入状态。
      return undefined;
    }
  }

  async #removeTyping(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.#api.removeReaction({ messageId, reactionId });
    } catch {
      // 移除失败不影响交付；消息上的表情会随消息留存。
    }
  }
}

/** 按文件头判断图片类型；平台给的 content-type 只作参考。 */
export function sniffImageType(bytes: Uint8Array, contentType?: string): OwnerImage['mediaType'] | null {
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.byteLength >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  const declared = contentType?.split(';')[0]?.trim().toLowerCase();
  if (declared !== undefined && KNOWN_IMAGE_TYPES.has(declared)) return declared as OwnerImage['mediaType'];
  return null;
}

/** 文件名只留叶子名，去掉控制字符与路径分隔符（协议要求）。 */
export function sanitizeFileName(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' ? '未命名文件' : cleaned.slice(0, 200);
}

function mediaTypeOfName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain';
  return undefined;
}

function extensionOf(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'png';
  }
}
