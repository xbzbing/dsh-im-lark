/**
 * `my-superagent/v1` 的飞书实现：把核心的交付变成卡片，把用户的消息与作答交回核心。
 *
 * 这里只做**协议语义**：幂等、流式修订、`supersedes`、回执字段、交互状态。
 * 具体怎么发、怎么切段在 `outbound.ts`；卡片长什么样在 `cards.ts`。
 *
 * 注册时机：凭据齐了才能拿到 `account`，所以 provider 必须在运行时可用之后再注册
 * （核心侧对「先注册后确定账号」没有宽容度）。
 */

import { DEFAULT_MAX_TEXT_CHARS } from '../shared/limits.ts';
import { InteractionStore, answerFromAction, renderAnsweredCard, renderDeliveryCard, renderRejectedCard, renderRetryCard, renderSupersededCard, cardFits } from './cards.ts';
import type { Card } from './cards.ts';
import type { LarkApi } from './lark/api.ts';
import type { LarkLogger } from './lark/connection.ts';
import type { LarkCardAction } from './lark/types.ts';
import { OutboundChannel } from './outbound.ts';
import { PROTOCOL_V1 } from './protocol.ts';
import type {
  AcceptResult,
  BridgeCapabilities,
  BridgeHandle,
  BridgeHealth,
  BridgeProvider,
  Delivery,
  InteractionAnswerDraft,
  OwnerMessageDraft,
  Receipt,
  RejectReason,
} from './protocol.ts';

/** 能力声明：与方案设计 6.3 一致，测试里会用核心的 Schema 再校验一次。 */
const CAPABILITIES: BridgeCapabilities = {
  markdown: 'full',
  maxText: { max: DEFAULT_MAX_TEXT_CHARS, unit: 'char' },
  interaction: Object.freeze({
    choice: true,
    multiChoice: true,
    freeText: true,
    maxOptions: 20,
    maxQuestions: 1,
    updateAfterAnswer: 'any',
  }),
  edit: Object.freeze({ scope: 'any', minIntervalMs: 2_000, maxLifetimeMs: 14 * 24 * 60 * 60 * 1000 }),
  detail: true,
  nativeCommands: false,
  quoteReply: true,
  quotas: Object.freeze([Object.freeze({ scope: 'conversation', max: 5, windowMs: 1_000 })]),
  outbound: Object.freeze({ requiresPriorInbound: false, images: true }),
};

export const LARK_CAPABILITIES: BridgeCapabilities = Object.freeze(CAPABILITIES);

export interface BridgeDeps {
  /** 桥的账号标识：用 App ID，重启与换版本都不变。 */
  account: string;
  api: LarkApi;
  logger?: LarkLogger;
  maxText?: number;
  now?: () => number;
  health?: () => BridgeHealth;
  /** 重启后还没收到入站消息时，从本机镜像的 owner 找到会话。 */
  chatFor?: (sender: string) => string | undefined;
  /**
   * 这一轮正常收尾后，给触发它的原消息补 `DONE`（入参是平台消息 id，桥已翻译好）。
   * 是否打表情（面板开关）由注入方判断；桥只在「完成且送达成功」时调用。
   */
  markDone?: (platformMessageId: string) => void;
}

export interface LarkBridge {
  readonly provider: BridgeProvider;
  readonly interactions: InteractionStore;
  /** 核心注册后把它的句柄交进来；未接入核心时保持空。 */
  attach(handle: BridgeHandle): void;
  detach(): void;
  /** 把一条入站消息交给核心；没接核心时回 `unknown`。 */
  receive(message: OwnerMessageDraft): Promise<AcceptResult>;
  /** 把一次作答交给核心。 */
  answer(answer: InteractionAnswerDraft): Promise<AcceptResult>;
  /** 处理卡片按钮回调：校验 → 交核心 → 把卡改成终态。 */
  applyCardAction(action: LarkCardAction): Promise<AcceptResult>;
  dispose(): void;
}

/**
 * 作答被拒的可见说明：核心模式没有独立模式那条提示通道，拒绝如果只写调试日志，
 * 用户看到的就是「点了没反应」。文案对齐独立模式（`questions.ts` 的提示）。
 */
const REJECT_NOTES: Record<Exclude<RejectReason, 'settled'>, string> = {
  invalid: '这张卡的作答信息不完整，请在 Web 端作答。',
  'not-owner': '这张卡只认主人作答，请在 Web 端作答。',
  unknown: '这张卡已经失效（插件重启过），不再接收作答；请在 Web 端重新作答。',
  expired: '这张卡已经过期，请在 Web 端重新作答。',
  'wrong-bridge': '这张卡不属于当前接入的机器人，请在 Web 端作答。',
  'not-delivered': '这张卡没有真正发出去，请在 Web 端作答。',
  'not-allowed': '审批要在 Web 端处理，飞书里不代答。',
  'invalid-answer': '没认出这次选择：单选题只能勾一项，勾选（或填「其他」）后点「提交」。',
};

/** 这些原因意味着卡不能再答：改成失效态，别留一排还能点的勾选框。 */
const TERMINAL_REJECTS = new Set<RejectReason>(['unknown', 'expired', 'wrong-bridge', 'not-delivered']);

/**
 * 带会话 `refs`、却**不是**正常收尾的两个已知结果：停滞提醒（任务可能还在跑）与
 * 重启孤儿收尾（结果没送回来）。核心把标题当自由文本，这里只能按固定文案排除；
 * 权威信号见 xbzbing/dsh-my-superagent#3，落地后与 `completionTarget` 一起删。
 */
const NON_COMPLETION_TITLES = new Set(['长时间没有动静', '这一轮没有正常收尾']);

/** 已交付记录与流式修订的内存上限：长跑进程不能让它们无限涨。 */
const MAX_DELIVERED = 2_000;
/** 入站引用表与「收件人 → 会话」表的上限。 */
const MAX_INBOUND = 500;
const MAX_SENDER_CHATS = 50;

export function createLarkBridge(deps: BridgeDeps): LarkBridge {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? {};
  const interactions = new InteractionStore();
  // 一个通道服务所有会话：幂等表按 deliveryId 建，与聊天无关。
  const outbound = new OutboundChannel({
    api: deps.api,
    maxText: deps.maxText ?? DEFAULT_MAX_TEXT_CHARS,
    logger,
    now,
  });

  let coreHandle: BridgeHandle | null = null;
  let capabilities: BridgeCapabilities = LARK_CAPABILITIES;
  let disposed = false;

  /** 已交付的记录：PATCH 终态与 supersedes 都要回看原文。 */
  const delivered = new Map<string, { delivery: Delivery; messageId: string }>();
  /** 流式交付的当前修订：低于它的修订不再产生平台操作。 */
  const streams = new Map<string, { revision: number; messageId: string }>();
  /** 卡片装不下的流：已用分条消息发过一次，后续修订不再原地 PATCH，避免消息瀑布。 */
  const detachedStreams = new Map<string, string>();
  /** 核心回引用的 `messageId` → 平台消息 id（有界）。 */
  const inbound = new Map<string, string>();
  /** 收件人（核心传的是 sender/open_id）→ 最近一次说话的会话 id（有界）。 */
  const senderChats = new Map<string, string>();

  const provider: BridgeProvider = {
    platform: 'lark',
    account: deps.account,
    protocol: [PROTOCOL_V1],
    get capabilities() {
      return capabilities;
    },
    deliver: (delivery) => deliver(delivery),
    health: () => deps.health?.() ?? { state: disposed ? 'down' : 'ok' },
  };


  async function deliver(delivery: Delivery): Promise<Receipt> {
    const deliveryId = delivery.id;
    if (disposed) return failure(deliveryId, 'other', '桥已销毁');

    if (delivery.expiresAt !== undefined && delivery.expiresAt <= now()) {
      return failure(deliveryId, 'window-closed', '交付已过期，未发送');
    }

    // 本轮正常收尾才补完成表情；判据见 completionTarget。
    const doneTarget = completionTarget(delivery);
    const markDone = (): void => {
      if (doneTarget !== undefined) deps.markDone?.(doneTarget);
    };

    const stream = delivery.stream;
    let streamOversized = false;
    if (stream !== undefined) {
      const detached = detachedStreams.get(stream.id);
      if (detached !== undefined) {
        // 已经用分条消息发过最终内容；后续修订再发只会刷屏。
        markDone();
        return { deliveryId, status: 'sent', bridgeMessageId: detached, messagesSent: 0 };
      }
      const current = streams.get(stream.id);
      if (current !== undefined && stream.revision < current.revision) {
        // 迟到的旧修订：什么都不做，但也要回「已送达」，否则核心会一直重投。
        return { deliveryId, status: 'sent', bridgeMessageId: current.messageId, messagesSent: 0 };
      }
      if (current !== undefined) {
        const card = renderDeliveryCard(delivery, { interactive: false });
        if (!cardFits(card)) {
          // 这次修订装不进卡片：只发一次分条最终稿，并把这条流标记为「不再原地更新」。
          streamOversized = true;
          logger.warn?.('流式卡片超过体积上限，改为一次性分条发送', stream.id);
        } else {
          try {
            await deps.api.patchCard({ messageId: current.messageId, card });
            remember(streams, stream.id, { revision: stream.revision, messageId: current.messageId }, MAX_DELIVERED);
            markDone();
            return { deliveryId, status: 'sent', bridgeMessageId: current.messageId, messagesSent: 0 };
          } catch (error) {
            logger.warn?.('流式更新失败，改为重新发送', errorText(error));
          }
        }
      }
    }

    const chatId = chatOf(delivery.recipient);
    if (chatId === undefined) {
      return failure(deliveryId, 'other', '收件人没有可用的会话：先让主人给机器人发一条消息');
    }

    const images = (delivery.images ?? []).map((image) => ({
      bytes: Buffer.from(image.data, 'base64'),
      fileName: image.name ?? `图片.${extensionOf(image.mediaType)}`,
    }));

    const card = renderDeliveryCard(delivery, { interactive: delivery.interaction !== undefined });
    const useCard = cardFits(card);
    // 交互卡装不下时明确降级并回失败码：只发纯文本再回「已送达」会让核心白等作答。
    const interactionDropped = delivery.interaction !== undefined && !useCard;
    const fallbackNote = interactionDropped ? '\n\n（内容超过卡片上限，交互已降级为纯文本；请在 Web 端作答。）' : '';
    const replyTarget = delivery.inReplyTo === undefined ? undefined : inbound.get(delivery.inReplyTo);

    let receipt: Awaited<ReturnType<OutboundChannel['deliver']>>;
    try {
      receipt = await outbound.deliver({
        deliveryId,
        chatId,
        text: useCard ? '' : `${renderFallbackText(delivery)}${fallbackNote}`,
        ...(useCard ? { card: card as Card } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(replyTarget === undefined ? {} : { replyTo: replyTarget }),
        ...(delivery.expiresAt === undefined ? {} : { expiresAt: delivery.expiresAt }),
        title: useCard ? undefined : delivery.title,
      });
    } catch (error) {
      return failure(deliveryId, 'other', errorText(error));
    }

    if (receipt.errorCode !== undefined) {
      return {
        deliveryId,
        status: 'failed',
        ...(receipt.messageIds[0] === undefined ? {} : { bridgeMessageId: receipt.messageIds[0] }),
        ...(receipt.messageIds.length === 0 ? {} : { bridgeMessageIds: receipt.messageIds }),
        messagesSent: receipt.messagesSent,
        errorCode: receipt.errorCode,
        ...(receipt.error === undefined ? {} : { error: receipt.error }),
      };
    }
    // 回答送达成功才补 DONE；发送失败只留「收到」，不给假信号。
    markDone();

    const messageId = receipt.messageIds[0];
    if (messageId !== undefined) {
      remember(delivered, deliveryId, { delivery, messageId }, MAX_DELIVERED);
      if (stream !== undefined) {
        if (streamOversized || !cardFits(card)) {
          remember(detachedStreams, stream.id, messageId, MAX_DELIVERED);
        } else {
          remember(streams, stream.id, { revision: stream.revision, messageId }, MAX_DELIVERED);
        }
      }
    }
    if (
      delivery.interaction !== undefined &&
      messageId !== undefined &&
      useCard &&
      delivery.interaction.questions.length === 1
    ) {
      // 同一交付被重投时不要把它从「已作答」打回待作答。
      const previous = interactions.get(deliveryId);
      interactions.add({
        deliveryId,
        chatId,
        messageId,
        questions: delivery.interaction.questions,
        createdAt: now(),
        ...(delivery.expiresAt === undefined ? {} : { expiresAt: delivery.expiresAt }),
        answered: previous?.answered ?? false,
      });
    }

    // 新卡发成功后再作废旧卡：发送失败时旧卡仍然有效，不会两头落空。
    if (delivery.supersedes !== undefined) await supersede(delivery.supersedes);

    const sent: Receipt = {
      deliveryId,
      status: 'sent',
      ...(messageId === undefined ? {} : { bridgeMessageId: messageId }),
      ...(receipt.messageIds.length === 0 ? {} : { bridgeMessageIds: receipt.messageIds }),
      messagesSent: receipt.messagesSent,
    };
    // 内容已经送达，只是交互改在 Web 端作答；回成功避免核心重投或换路由。
    return interactionDropped
      ? { ...sent, error: '交互卡片超过平台上限，已降级为纯文本；请在 Web 端作答' }
      : sent;
  }

  /**
   * 这条交付是不是「这一轮的正常收尾」，是则给出要补 `DONE` 的原消息（平台 id）。
   *
   * 核心把完成、停滞提醒、孤儿收尾、分发回执都发成 `intent:'result'`，大多还带
   * `inReplyTo`，桥不能只看 intent 就当完成（分发回执打 DONE 就是「任务还没完成却
   * 盖了完成」的假信号）。临时判据，被单测钉死；核心补上权威回合结束信号
   * （xbzbing/dsh-my-superagent#3）后整体替换：
   * - 流式：`stream.final === true` 是权威完成信号（`LiveRelay.finish` 只在正常收尾调，
   *   迟到的旧修订与进度修订都不是 final）；
   * - 非流式（核心 `conversationGranularity='result'`）：正常收尾必带会话 `refs`，
   *   而分发回执/提示/速办失败都不带；两个带 refs 的已知非完成项按固定标题排除。
   */
  function completionTarget(delivery: Delivery): string | undefined {
    if (delivery.inReplyTo === undefined) return undefined;
    const complete =
      delivery.stream !== undefined
        ? delivery.stream.final === true
        : delivery.intent === 'result' &&
          (delivery.refs ?? []).length > 0 &&
          !NON_COMPLETION_TITLES.has(delivery.title);
    if (!complete) return undefined;
    // inReplyTo → 平台消息 id；不在这张表里（重启丢映射、非本桥消息）就不打。
    return inbound.get(delivery.inReplyTo);
  }

  /** 核心传的是 sender/open_id；飞书发消息要 chat_id，用入站学到的映射翻译。 */
  function chatOf(recipient: string): string | undefined {
    const learned = senderChats.get(recipient);
    if (learned !== undefined) return learned;
    const persisted = deps.chatFor?.(recipient);
    if (persisted !== undefined && persisted !== '') return persisted;
    // 显式给会话 id 的调用方（一致性测试、命令行）原样放行。
    return recipient.startsWith('oc_') ? recipient : undefined;
  }

  /** 旧卡改成终态；失败只记日志，不能让新交付因此失败。 */
  async function supersede(deliveryId: string): Promise<void> {
    const record = delivered.get(deliveryId);
    if (record === undefined) {
      logger.warn?.('旧卡片已不在内存里，无法标记为已替代', deliveryId);
      return;
    }
    try {
      await deps.api.patchCard({ messageId: record.messageId, card: renderSupersededCard(record.delivery) });
    } catch (error) {
      logger.debug?.('旧卡片改写失败', errorText(error));
    }
    interactions.markAnswered(deliveryId);
  }

  /**
   * 作答被拒时说清原因。
   *
   * 核心模式没有独立模式那条提示通道：拒绝如果只写调试日志，用户看到的就是「点了没反应」。
   * 能答的卡要**重画**——飞书的表单提交是一次性的，提交过的卡不会再触发回调，只发一句
   * 提示等于把这张卡废掉；不能再答的直接改成失效态。都改写同一张卡，所以不会刷屏；
   * 只有卡不在手里（重启丢了记录、回调缺 id）才退化成一条文字提示，同卡同原因只发一次。
   */
  async function noteRejected(
    action: LarkCardAction,
    reason: RejectReason,
    deliveryId: string | undefined,
  ): Promise<void> {
    if (reason === 'settled') return; // 已经答过了，再提示只会吵。
    const note = REJECT_NOTES[reason];
    const terminal = TERMINAL_REJECTS.has(reason);
    const record = deliveryId === undefined ? undefined : delivered.get(deliveryId);
    if (record !== undefined) {
      const card = terminal ? renderRejectedCard(record.delivery, note) : renderRetryCard(record.delivery, note);
      try {
        await deps.api.patchCard({ messageId: record.messageId, card });
        if (terminal && deliveryId !== undefined) interactions.delete(deliveryId);
        return;
      } catch (error) {
        logger.debug?.('卡片改写失败，改为发提示', errorText(error));
      }
    }
    const key = `note:${action.messageId}:${reason}`;
    const receipt = await outbound.deliver({ deliveryId: key, chatId: action.chatId, text: note }).catch((error: unknown) => {
      logger.debug?.('作答被拒的提示没发出去', errorText(error));
      return undefined;
    });
    if (receipt !== undefined && receipt.errorCode !== undefined) {
      logger.debug?.('作答被拒的提示发送失败', `${receipt.errorCode} ${receipt.error ?? ''}`);
    }
  }

  async function applyCardAction(action: LarkCardAction): Promise<AcceptResult> {
    const deliveryId = typeof action.value.d === 'string' ? action.value.d : undefined;
    const result = answerFromAction(action.value, action.option, action.formValues, action.operatorOpenId, interactions, now());
    if ('reason' in result) {
      await noteRejected(action, result.reason, deliveryId);
      return { accepted: false, reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) };
    }

    const accepted = await answer(result);
    if (!accepted.accepted) {
      await noteRejected(action, accepted.reason, deliveryId);
      return accepted;
    }

    interactions.markAnswered(result.deliveryId);
    const record = delivered.get(result.deliveryId);
    if (record === undefined) return { accepted: true };

    // 终态改写异步做：回调本身必须在 3 秒内返回。
    void deps.api
      .patchCard({ messageId: record.messageId, card: renderAnsweredCard(record.delivery, result.answers) })
      .catch((error: unknown) => {
        logger.debug?.('作答后卡片改写失败', errorText(error));
      });
    return { accepted: true };
  }

  async function receive(message: OwnerMessageDraft): Promise<AcceptResult> {
    // 先记映射再交核心：核心可能在 receive 返回后立刻回交付。
    if (message.chatId !== undefined && message.chatId !== '' && message.sender !== '') {
      remember(senderChats, message.sender, message.chatId, MAX_SENDER_CHATS);
    }
    if (message.platformMessageId !== undefined && message.platformMessageId !== '') {
      remember(inbound, message.messageId, message.platformMessageId, MAX_INBOUND);
    }
    if (coreHandle === null) return { accepted: false, reason: 'unknown' };
    return coreHandle.receive(message);
  }

  async function answer(draft: InteractionAnswerDraft): Promise<AcceptResult> {
    if (coreHandle === null) return { accepted: false, reason: 'unknown' };
    return coreHandle.answer(draft);
  }

  function attach(handle: BridgeHandle): void {
    coreHandle = handle;
    // 核心可能改我们的能力（例如降级 markdown），跟着它走。
    handle.update(capabilities);
  }

  function detach(): void {
    const handle = coreHandle;
    coreHandle = null;
    try {
      handle?.dispose();
    } catch (error) {
      // 核心清理失败不该把插件的停机流程一起带崩。
      logger.warn?.('释放核心句柄失败', errorText(error));
    }
  }

  function dispose(): void {
    disposed = true;
    detach();
    delivered.clear();
    streams.clear();
    detachedStreams.clear();
    interactions.clear();
  }

  return { provider, interactions, attach, detach, receive, answer, applyCardAction, dispose };
}

/** 有界 Map：超出上限先删最早插入的键（Map 保序）。 */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  // 先删再插：Map 的迭代顺序就是淘汰顺序，命中要刷新，否则热键会被旧键挤掉。
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** 协议规定 `Receipt.error` 最多 500 字符；超长会让核心解析失败并按 uncertain 重投。 */
function truncateError(error: string): string {
  return error.length > 500 ? `${error.slice(0, 497)}...` : error;
}

function failure(deliveryId: string, errorCode: NonNullable<Receipt['errorCode']>, error: string): Receipt {
  return { deliveryId, status: 'failed', messagesSent: 0, errorCode, error: truncateError(error) };
}

/** 卡片装不下时退回「标题 + 正文」：由 outbound 按文本分条。 */
function renderFallbackText(delivery: Delivery): string {
  return [`# ${delivery.title}`, delivery.body, delivery.detail ?? ''].filter((part) => part !== '').join('\n\n');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
