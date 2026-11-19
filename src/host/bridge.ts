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
import { InteractionStore, answerFromAction, renderAnsweredCard, renderDeliveryCard, renderSupersededCard, cardFits } from './cards.ts';
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
    maxQuestions: 5,
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
  /** 记下我们收到的平台消息 id：只有引用这些消息时 reply 才不会被平台拒。 */
  recordInbound(platformMessageId: string): void;
  /** 处理卡片按钮回调：校验 → 交核心 → 把卡改成终态。 */
  applyCardAction(action: LarkCardAction): Promise<AcceptResult>;
  dispose(): void;
}

const MAX_KNOWN_INBOUND = 500;
/** 已交付记录与流式修订的内存上限：长跑进程不能让它们无限涨。 */
const MAX_DELIVERED = 500;

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
  /** 我们收到过的平台消息 id（有界）。 */
  const knownInbound = new Set<string>();

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

    const stream = delivery.stream;
    if (stream !== undefined) {
      const current = streams.get(stream.id);
      if (current !== undefined && stream.revision < current.revision) {
        // 迟到的旧修订：什么都不做，但也要回「已送达」，否则核心会一直重投。
        return { deliveryId, status: 'sent', bridgeMessageId: current.messageId, messagesSent: 0 };
      }
      if (current !== undefined) {
        const card = renderDeliveryCard(delivery, { interactive: false });
        try {
          await deps.api.patchCard({ messageId: current.messageId, card });
          remember(streams, stream.id, { revision: stream.revision, messageId: current.messageId }, MAX_DELIVERED);
          return { deliveryId, status: 'sent', bridgeMessageId: current.messageId, messagesSent: 0 };
        } catch (error) {
          logger.warn?.('流式更新失败，改为重新发送', errorText(error));
        }
      }
    }

    if (delivery.supersedes !== undefined) await supersede(delivery.supersedes);

    const images = (delivery.images ?? []).map((image) => ({
      bytes: Buffer.from(image.data, 'base64'),
      fileName: image.name ?? `图片.${extensionOf(image.mediaType)}`,
    }));

    const card = renderDeliveryCard(delivery, { interactive: delivery.interaction !== undefined });
    const useCard = cardFits(card);

    let receipt: Awaited<ReturnType<OutboundChannel['deliver']>>;
    try {
      receipt = await outbound.deliver({
        deliveryId,
        chatId: delivery.recipient,
        text: useCard ? '' : renderFallbackText(delivery),
        ...(useCard ? { card: card as Card } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(delivery.inReplyTo !== undefined && knownInbound.has(delivery.inReplyTo) ? { replyTo: delivery.inReplyTo } : {}),
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

    const messageId = receipt.messageIds[0];
    if (messageId !== undefined) {
      remember(delivered, deliveryId, { delivery, messageId }, MAX_DELIVERED);
      if (stream !== undefined) remember(streams, stream.id, { revision: stream.revision, messageId }, MAX_DELIVERED);
    }
    if (delivery.interaction !== undefined && messageId !== undefined && useCard) {
      interactions.add({
        deliveryId,
        chatId: delivery.recipient,
        messageId,
        questions: delivery.interaction.questions,
        createdAt: now(),
        ...(delivery.expiresAt === undefined ? {} : { expiresAt: delivery.expiresAt }),
        answered: false,
      });
    }

    return {
      deliveryId,
      status: 'sent',
      ...(messageId === undefined ? {} : { bridgeMessageId: messageId }),
      ...(receipt.messageIds.length === 0 ? {} : { bridgeMessageIds: receipt.messageIds }),
      messagesSent: receipt.messagesSent,
    };
  }

  /** 旧卡改成终态；失败只记日志，不能让新交付因此失败。 */
  async function supersede(deliveryId: string): Promise<void> {
    const record = delivered.get(deliveryId);
    if (record === undefined) return;
    try {
      await deps.api.patchCard({ messageId: record.messageId, card: renderSupersededCard(record.delivery) });
    } catch (error) {
      logger.debug?.('旧卡片改写失败', errorText(error));
    }
    interactions.markAnswered(deliveryId);
  }

  async function applyCardAction(action: LarkCardAction): Promise<AcceptResult> {
    const result = answerFromAction(action.value, action.option, action.operatorOpenId, interactions, now());
    if ('reason' in result) return { accepted: false, reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) };

    const accepted = await answer(result);
    if (!accepted.accepted) return accepted;

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

  function recordInbound(platformMessageId: string): void {
    if (platformMessageId === '') return;
    knownInbound.add(platformMessageId);
    while (knownInbound.size > MAX_KNOWN_INBOUND) {
      const oldest = knownInbound.values().next();
      if (oldest.done) break;
      knownInbound.delete(oldest.value);
    }
  }

  function dispose(): void {
    disposed = true;
    detach();
    delivered.clear();
    streams.clear();
    interactions.clear();
  }

  return { provider, interactions, attach, detach, receive, answer, recordInbound, applyCardAction, dispose };
}

/** 有界 Map：超出上限先删最早插入的键（Map 保序）。 */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function failure(deliveryId: string, errorCode: NonNullable<Receipt['errorCode']>, error: string): Receipt {
  return { deliveryId, status: 'failed', messagesSent: 0, errorCode, error };
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
