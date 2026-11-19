/**
 * 入站转换：事件包装 → 一条可处理的入站消息 + 结构化的正文。
 *
 * 这一层只做**纯解析**：不下载媒体、不访问网络、不查配置。调用方（`bridge` 或
 * `standalone`）拿到 `InboundBody` 后再决定要不要下载、要不要交给模型。这样解析
 * 规则可以用假事件全覆盖，也不需要为了测一个 @ 剥离去连飞书。
 *
 * 字段形状以 `docs/protocol/00-飞书开放平台事实.md` §2 为准。
 */

import type { LarkChatType, LarkInboundMessage, LarkMention } from './lark/types.ts';

/** 正文里引用到的媒体：只有 key，下载是调用方的事。 */
export interface InboundImageRef {
  imageKey: string;
}

export interface InboundFileRef {
  fileKey: string;
  fileName: string;
}

export interface InboundBody {
  /** 已剥离 @ 占位符的纯文本；富文本按阅读顺序拍平。 */
  text: string;
  images: InboundImageRef[];
  files: InboundFileRef[];
  /** 解析不了或暂不支持的类型，调用方据此决定提示语。 */
  unsupported?: string;
}

export type InboundParse =
  | { kind: 'message'; message: LarkInboundMessage; body: InboundBody }
  | { kind: 'ignored'; reason: string };

export interface ParseOptions {
  /** 机器人自己的 open_id；已知时按它区分「@我」与「@别人」。 */
  botOpenId?: string;
}

/** 群里只有 @机器人 才会推送；没有这条权限时不猜，直接跳过。 */
const GROUP_REQUIRE_MENTION = true;

interface RawEvent {
  header?: { event_id?: string; event_type?: string; create_time?: string };
  event?: {
    sender?: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string };
      sender_type?: string;
    };
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      thread_id?: string;
      create_time?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: unknown[];
    };
  };
}

/**
 * 解析 `im.message.receive_v1` 事件。
 *
 * 返回值只有两种：可处理的消息，或一条带原因的忽略。忽略的原因会进日志，便于
 * 排查「为什么机器人没反应」。
 */
export function parseMessageEvent(raw: unknown, options: ParseOptions = {}): InboundParse {
  const envelope = asRecord(raw) as RawEvent | null;
  const event = asRecord(envelope?.event);
  if (event === null) return { kind: 'ignored', reason: '事件缺少 event 字段' };

  const message = asRecord(event.message);
  if (message === null) return { kind: 'ignored', reason: '事件缺少 message 字段' };

  const messageId = asText(message.message_id);
  const chatId = asText(message.chat_id);
  if (messageId === '' || chatId === '') return { kind: 'ignored', reason: '消息缺少 message_id 或 chat_id' };

  const sender = asRecord(event.sender);
  const senderType = asText(sender?.sender_type) === 'app' ? 'bot' : 'user';
  if (senderType === 'bot') return { kind: 'ignored', reason: '机器人自己发的消息' };

  const chatType: LarkChatType = asText(message.chat_type) === 'group' ? 'group' : 'p2p';
  const mentions = parseMentions(message.mentions);
  if (GROUP_REQUIRE_MENTION && chatType === 'group' && !hasMentionOf(mentions, options.botOpenId)) {
    return { kind: 'ignored', reason: '群里没有 @机器人' };
  }

  const messageType = asText(message.message_type) || 'unknown';
  const content = asText(message.content);
  const body = parseContent(messageType, content, mentions, options);

  const parsed: LarkInboundMessage = {
    messageId,
    chatId,
    chatType,
    messageType,
    content,
    createTime: toMillis(message.create_time),
    ...(asText(message.parent_id) ? { parentId: asText(message.parent_id) } : {}),
    ...(asText(message.root_id) ? { rootId: asText(message.root_id) } : {}),
    ...(asText(message.thread_id) ? { threadId: asText(message.thread_id) } : {}),
    senderOpenId: asText(asRecord(sender?.sender_id)?.open_id),
    senderType,
    mentions,
  };

  return { kind: 'message', message: parsed, body };
}

/** 按消息类型拍平正文。解析失败时降级成一句提示，不让整条消息消失。 */
function parseContent(
  messageType: string,
  content: string,
  mentions: readonly LarkMention[],
  options: ParseOptions,
): InboundBody {
  switch (messageType) {
    case 'text': {
      const payload = parseJson(content);
      const text = stripMentions(asText(payload?.text), mentions, options);
      return { text, images: [], files: [] };
    }
    case 'post': {
      const payload = parseJson(content);
      return flattenPost(payload, options);
    }
    case 'image': {
      const imageKey = asText(parseJson(content)?.image_key);
      return imageKey === ''
        ? { text: '', images: [], files: [], unsupported: 'image' }
        : { text: '', images: [{ imageKey }], files: [] };
    }
    case 'file': {
      const payload = parseJson(content);
      const fileKey = asText(payload?.file_key);
      return fileKey === ''
        ? { text: '', images: [], files: [], unsupported: 'file' }
        : {
            text: '',
            images: [],
            files: [{ fileKey, fileName: asText(payload?.file_name) || '未命名文件' }],
          };
    }
    default:
      // 语音、视频、表情包、合并转发……统一提示，避免用户以为消息丢了。
      return { text: '', images: [], files: [], unsupported: messageType };
  }
}

interface PostElement {
  tag?: string;
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  image_key?: string;
  file_key?: string;
  file_name?: string;
  emoji_type?: string;
  language?: string;
  [key: string]: unknown;
}

/**
 * 富文本拍平。
 *
 * 飞书两种形态：老 `post` 的 `{title, content:[[...]]}`，和带 `content_v2` 的新
 * 形态（可能按 `zh_cn`/`en_us` 本地化）。这里都接，取中文优先。
 */
function flattenPost(payload: Record<string, unknown> | null, options: ParseOptions): InboundBody {
  if (payload === null) return { text: '', images: [], files: [], unsupported: 'post' };

  const localized = pickLocalized(payload);
  const title = asText(localized.title);
  const paragraphs = localized.content;

  const lines: string[] = [];
  if (title !== '') lines.push(title);

  const images: InboundImageRef[] = [];
  const files: InboundFileRef[] = [];

  if (Array.isArray(paragraphs)) {
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const text = paragraph
        .map((element) => flattenPostElement(asRecord(element) as PostElement | null, options, images, files))
        .join('');
      if (text !== '') lines.push(text);
    }
  } else if (asText(localized.content_v2) !== '') {
    // `content_v2` 里的 `md` 标签保留原始 Markdown，直接用比拍平更准。
    lines.push(asText(localized.content_v2));
  }

  return { text: lines.join('\n').trim(), images, files };
}

function flattenPostElement(
  element: PostElement | null,
  options: ParseOptions,
  images: InboundImageRef[],
  files: InboundFileRef[],
): string {
  if (element === null) return '';
  switch (element.tag) {
    case 'text':
      return asText(element.text);
    case 'a':
      return asText(element.text) === '' ? asText(element.href) : `[${asText(element.text)}](${asText(element.href)})`;
    case 'at': {
      const openId = asText(element.user_id);
      const name = asText(element.user_name);
      // 富文本的 @ 自带名字，能保留就保留；只有确认是机器人时才删掉。
      if (options.botOpenId !== undefined && options.botOpenId !== '' && openId === options.botOpenId) return '';
      return name === '' ? '' : `@${name}`;
    }
    case 'img': {
      const imageKey = asText(element.image_key);
      if (imageKey !== '') images.push({ imageKey });
      return '';
    }
    case 'media':
    case 'file': {
      const fileKey = asText(element.file_key);
      if (fileKey !== '') files.push({ fileKey, fileName: asText(element.file_name) || '未命名文件' });
      return '';
    }
    case 'emotion':
      return asText(element.emoji_type) === '' ? '' : `[${asText(element.emoji_type)}]`;
    case 'code_block':
      return `\n\`\`\`${asText(element.language)}\n${asText(element.text)}\n\`\`\`\n`;
    case 'hr':
      return '\n---\n';
    default:
      return asText(element.text);
  }
}

/** 本地化容器：`{zh_cn:{...}, en_us:{...}}` 或直接就是 `{title, content}`。 */
function pickLocalized(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['zh_cn', 'en_us', 'ja_jp']) {
    const value = asRecord(payload[key]);
    if (value !== null) return value;
  }
  return payload;
}

/**
 * 去掉 @ 占位符。
 *
 * 已知机器人 open_id 时：@机器人 直接删掉，@别人 还原成 `@名字`（保留语义）。
 * 不知道时全部删掉——群消息是「@机器人」触发的，占位符留在正文里只会干扰模型。
 */
export function stripMentions(text: string, mentions: readonly LarkMention[], options: ParseOptions = {}): string {
  if (text === '') return '';

  let result = text;
  for (const mention of mentions) {
    const replacement = isBotMention(mention, mentions, options) ? '' : mention.name ? `@${mention.name}` : '';
    result = result.split(mention.key).join(replacement);
  }
  // `@_all` 在正文里可能出现，但没有对应 mention；直接删。
  result = result.replace(/@_all\b/g, '');
  return result.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function isBotMention(
  mention: { openId?: string | undefined; name?: string | undefined },
  mentions: readonly LarkMention[],
  options: ParseOptions,
): boolean {
  if (options.botOpenId !== undefined && options.botOpenId !== '') return mention.openId === options.botOpenId;
  // 不知道机器人是谁时，只能按「这条是 @ 触发」的语义处理：把 mention 都当作机器人。
  return mention.openId !== '' || mentions.length > 0;
}

function hasMentionOf(mentions: readonly LarkMention[], botOpenId: string | undefined): boolean {
  if (mentions.length === 0) return false;
  if (botOpenId === undefined || botOpenId === '') return true;
  return mentions.some((mention) => mention.openId === botOpenId);
}

function parseMentions(raw: unknown): LarkMention[] {
  if (!Array.isArray(raw)) return [];
  const mentions: LarkMention[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) continue;
    const key = asText(record.key);
    if (key === '') continue;
    const id = asRecord(record.id);
    mentions.push({
      key,
      ...(asText(record.name) ? { name: asText(record.name) } : {}),
      ...(asText(id?.open_id) ? { openId: asText(id?.open_id) } : {}),
      ...(asText(id?.user_id) ? { userId: asText(id?.user_id) } : {}),
      ...(asText(record.mentioned_type) === 'bot' ? { isBot: true } : {}),
    });
  }
  return mentions;
}

function parseJson(text: string): Record<string, unknown> | null {
  if (text === '') return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 事件里的时间是字符串毫秒；缺省用 0（后续按需改成 Date.now）。 */
function toMillis(value: unknown): number {
  const text = asText(value);
  if (text === '') return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}
