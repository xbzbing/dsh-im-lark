/**
 * 飞书 OpenAPI 的端口与其 SDK 实现。
 *
 * 端口只描述**本插件需要的动作**，参数是已经渲染好的内容（`content` 是 JSON
 * 字符串），这样渲染层与传输层各自演进：换 SDK、换传输方式都不动渲染。
 *
 * 错误一律收敛成 `LarkFailure`（`errors.ts`），调用方按 `kind` 决定重试与降级。
 */

import { LarkFailure as Failure, failureOfCode } from './errors.ts';
import type { LarkLogger } from './connection.ts';
import type {
  LarkCardAction,
  LarkDomain,
  LarkResource,
  LarkSendOptions,
  LarkSendResult,
  LarkUploadedFile,
  LarkUploadedImage,
} from './types.ts';

/** SDK 的 `Client` 只用到这几个动作，其余按 `unknown` 收着。 */
export interface SdkClientLike {
  im: {
    v1: {
      message: {
        create(payload: unknown): Promise<unknown>;
        reply(payload: unknown): Promise<unknown>;
        patch(payload: unknown): Promise<unknown>;
        delete(payload: unknown): Promise<unknown>;
      };
      messageReaction: {
        create(payload: unknown): Promise<unknown>;
        delete(payload: unknown): Promise<unknown>;
      };
      image: { create(payload: unknown): Promise<unknown> };
      file: { create(payload: unknown): Promise<unknown> };
      messageResource: { get(payload: unknown): Promise<unknown> };
    };
  };
}

/** 出站动作的端口。 */
export interface LarkApi {
  /** 发一条消息到会话。 */
  createMessage(input: {
    chatId: string;
    msgType: string;
    content: string;
    options?: LarkSendOptions;
  }): Promise<LarkSendResult>;

  /** 回复某条消息。 */
  replyMessage(input: {
    messageId: string;
    msgType: string;
    content: string;
    options?: LarkSendOptions;
  }): Promise<LarkSendResult>;

  /** 原地更新一条卡片消息。 */
  patchCard(input: { messageId: string; card: unknown }): Promise<void>;

  /** 撤回自己发的消息。 */
  recallMessage(input: { messageId: string }): Promise<void>;

  /** 给消息加表情回应（输入状态的实现基础）。 */
  addReaction(input: { messageId: string; emojiType: string }): Promise<{ reactionId: string }>;

  /** 移除自己加的表情回应。 */
  removeReaction(input: { messageId: string; reactionId: string }): Promise<void>;

  /** 上传图片（≤10 MB）。 */
  uploadImage(input: { bytes: Uint8Array; fileName: string }): Promise<LarkUploadedImage>;

  /** 上传文件（≤30 MB）。 */
  uploadFile(input: {
    bytes: Uint8Array;
    fileName: string;
    fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
  }): Promise<LarkUploadedFile>;

  /** 下载消息里的资源（图片或文件）。 */
  downloadResource(input: {
    messageId: string;
    fileKey: string;
    type: 'image' | 'file';
  }): Promise<LarkResource>;
}

/** 平台错误码里「不是错误」的那个值。 */
const OK = 0;

interface RawEnvelope {
  code?: number;
  msg?: string;
  data?: unknown;
  image_key?: string;
  file_key?: string;
}

/**
 * 把 SDK 的返回值收敛成 `data`。
 *
 * SDK 的两类返回：携带 `code/msg/data` 的信封，与直接返回字段的对象（上传接口）。
 * `code !== 0` 一律抛 `LarkFailure`——SDK 不会为业务错误 reject，漏判就会把失败
 * 当成功记进回执。
 */
function unwrap(raw: unknown, operation: string): Record<string, unknown> {
  if (raw === null || raw === undefined) {
    throw new Failure({ kind: 'other', message: `${operation}: 平台返回空响应` });
  }
  const value = raw as RawEnvelope;
  if (typeof value.code === 'number' && value.code !== OK) {
    throw failureOfCode(value.code, `${operation}: ${value.msg ?? '未知错误'}`);
  }
  if (value.data && typeof value.data === 'object') return value.data as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function messageIdOf(data: Record<string, unknown>, operation: string): string {
  const id = data.message_id;
  if (typeof id !== 'string' || id === '') {
    throw new Failure({ kind: 'other', message: `${operation}: 响应缺少 message_id` });
  }
  return id;
}

/** 让二进制在 SDK 里能被当作 `Buffer | ReadStream` 接受。 */
function asSdkFile(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export interface SdkApiOptions {
  client: SdkClientLike;
  logger?: LarkLogger;
  /** 单次下载的超时；默认 30 秒。 */
  downloadTimeoutMs?: number;
}

/** 用官方 SDK 的 `Client` 实现端口。 */
export function createSdkLarkApi(options: SdkApiOptions): LarkApi {
  const { client } = options;

  return {
    async createMessage({ chatId, msgType, content, options: send }) {
      const data = unwrap(
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: msgType,
            content,
            ...(send?.uuid ? { uuid: send.uuid } : {}),
          },
        }),
        '发送消息',
      );
      return { messageId: messageIdOf(data, '发送消息'), chatId: typeof data.chat_id === 'string' ? data.chat_id : chatId };
    },

    async replyMessage({ messageId, msgType, content, options: send }) {
      const data = unwrap(
        await client.im.v1.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: msgType,
            content,
            ...(send?.uuid ? { uuid: send.uuid } : {}),
          },
        }),
        '回复消息',
      );
      return {
        messageId: messageIdOf(data, '回复消息'),
        chatId: typeof data.chat_id === 'string' ? data.chat_id : undefined,
      };
    },

    async patchCard({ messageId, card }) {
      unwrap(
        await client.im.v1.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card) },
        }),
        '更新卡片',
      );
    },

    async recallMessage({ messageId }) {
      unwrap(await client.im.v1.message.delete({ path: { message_id: messageId } }), '撤回消息');
    },

    async addReaction({ messageId, emojiType }) {
      const data = unwrap(
        await client.im.v1.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: emojiType } },
        }),
        '添加表情回应',
      );
      const reactionId = data.reaction_id;
      if (typeof reactionId !== 'string' || reactionId === '') {
        throw new Failure({ kind: 'other', message: '添加表情回应：响应缺少 reaction_id' });
      }
      return { reactionId };
    },

    async removeReaction({ messageId, reactionId }) {
      unwrap(
        await client.im.v1.messageReaction.delete({
          path: { message_id: messageId, reaction_id: reactionId },
        }),
        '移除表情回应',
      );
    },

    async uploadImage({ bytes, fileName }) {
      if (bytes.byteLength === 0) {
        throw new Failure({ kind: 'other', message: '上传图片：文件为空' });
      }
      const data = unwrap(
        await client.im.v1.image.create({
          data: { image_type: 'message', image: asSdkFile(bytes) },
        }),
        `上传图片 ${fileName}`,
      );
      const imageKey = data.image_key;
      if (typeof imageKey !== 'string' || imageKey === '') {
        throw new Failure({ kind: 'other', message: '上传图片：响应缺少 image_key' });
      }
      return { imageKey };
    },

    async uploadFile({ bytes, fileName, fileType }) {
      if (bytes.byteLength === 0) {
        throw new Failure({ kind: 'other', message: '上传文件：文件为空' });
      }
      const data = unwrap(
        await client.im.v1.file.create({
          data: { file_type: fileType, file_name: fileName, file: asSdkFile(bytes) },
        }),
        `上传文件 ${fileName}`,
      );
      const fileKey = data.file_key;
      if (typeof fileKey !== 'string' || fileKey === '') {
        throw new Failure({ kind: 'other', message: '上传文件：响应缺少 file_key' });
      }
      return { fileKey };
    },

    async downloadResource({ messageId, fileKey, type }) {
      const timeoutMs = options.downloadTimeoutMs ?? 30_000;
      const raw = await withTimeout(
        client.im.v1.messageResource.get({
          params: { type },
          path: { message_id: messageId, file_key: fileKey },
        }),
        timeoutMs,
        '下载资源',
      );
      // SDK 在流式下载时返回带 `writeFile`/`getReadableStream` 的句柄；二进制的
      // 读取方式随版本不同，这里两种都认：能直接拿到流就整段读出，拿到 buffer 就直接用。
      const bytes = await readStreamLike(raw);
      return { bytes: bytes.bytes, contentType: bytes.contentType };
    },
  };
}

/** 带超时的 Promise：超时抛 `network`，让调用方按可重试处理。 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Failure({ kind: 'network', message: `${operation}：超时 ${timeoutMs}ms` }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface StreamLike {
  getReadableStream?: () => NodeJS.ReadableStream;
  writeFile?: (path: string) => Promise<unknown>;
  headers?: Record<string, string>;
}

/** 把 SDK 的下载结果读成字节。 */
async function readStreamLike(raw: unknown): Promise<LarkResource & { contentType?: string }> {
  if (raw === null || raw === undefined) {
    throw new Failure({ kind: 'other', message: '下载资源：平台返回空响应' });
  }
  if (raw instanceof Uint8Array) return { bytes: raw };
  if (raw instanceof ArrayBuffer) return { bytes: new Uint8Array(raw) };

  const value = raw as StreamLike & { [key: string]: unknown };
  const contentType = value.headers?.['content-type'];

  if (typeof value.getReadableStream === 'function') {
    const stream = value.getReadableStream();
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return { bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), contentType };
  }

  // 有些版本把内容直接挂在 `data` 上。
  const inner = value.data;
  if (inner instanceof Uint8Array) return { bytes: inner, contentType };
  if (inner instanceof ArrayBuffer) return { bytes: new Uint8Array(inner), contentType };

  throw new Failure({ kind: 'other', message: '下载资源：无法读取响应体' });
}

/** 从 SDK 抛出的错误里拿到可用于面板展示的一句话（已脱敏：不含 token）。 */
export function describeFailure(error: unknown): string {
  if (error instanceof Failure) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 消息类型的规范化：SDK 与事件里的取值都走这里。 */
export function normalizeMessageType(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : 'unknown';
}

/** 卡片回调里取到的 `value` 一定是对象（飞书要求）。 */
export function normalizeActionValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 卡片的域基址（面板自检与错误提示里会用到）。 */
export function baseUrlOf(domain: LarkDomain): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

/** 只给日志用的一行摘要。 */
export function summarizeAction(action: LarkCardAction): string {
  return `card.action ${action.messageId} ${JSON.stringify(action.value)}`;
}
