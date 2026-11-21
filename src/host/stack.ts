/**
 * 一次连接对应的整套对象：OpenAPI 客户端、桥、入站流水线、事件去向。
 *
 * 凭据换了就必须整套重建（客户端里缓存着 token），所以这里做成工厂而不是
 * 在入口里逐个 new。核心连上来/断开的注册动作不在这里做：那属于协议接线，
 * 由入口统一处理，`stack` 只保证「有一份可用的桥」。
 */

import type { LocalSettings, NormalizedConfig } from './config.ts';
import { createLarkBridge } from './bridge.ts';
import type { LarkBridge } from './bridge.ts';
import { InboundPipeline } from './inbound-pipeline.ts';
import { createSdkLarkApi } from './lark/api.ts';
import type { LarkApi, SdkClientLike } from './lark/api.ts';
import type { LarkLogger } from './lark/connection.ts';
import { createSdkClient } from './lark/sdk.ts';
import type { LarkCredentials } from './lark/types.ts';
import { OutboundChannel } from './outbound.ts';
import type { BridgeHealth, OwnerMessageDraft } from './protocol.ts';
import type { LarkEventSink } from './runtime.ts';
import { StandaloneChat } from './standalone.ts';
import type { StandaloneController } from './standalone.ts';
import type { DirectBindingStore, OwnerStore } from './state/direct.ts';

export interface LarkStackOptions {
  app: LarkCredentials;
  config: NormalizedConfig;
  logger: LarkLogger;
  /** 收到消息是否打表情；来自面板设置。 */
  typing?: boolean;
  botOpenId?: () => string | undefined;
  ownerOpenId?: () => string | undefined;
  features?: () => readonly string[];
  isOwner?: (sender: string) => boolean | undefined;
  onOwner?: (sender: string, chatId: string, chatType: 'p2p' | 'group') => void;
  /** 当前设置（独立模式要读排队方式与状态行开关）。 */
  settings: () => LocalSettings;
  bindings: DirectBindingStore;
  owners: OwnerStore;
  /** 宿主的会话控制器；没注入时为 null（独立模式不可用）。 */
  controller: () => StandaloneController | null;
  /** 独立模式的默认工作区 id（插件自动创建）；空串表示用宿主默认位置。 */
  workspaceId?: () => string;
  /**
   * 入站文本先给提醒认领：返回 true 表示这条消息是问题/授权的作答，不再进会话。
   * 没有提醒在等时恒为 false。
   */
  claim?: (draft: OwnerMessageDraft) => boolean;
  ownerLabel?: () => string;
  /** 长连接健康度：断线时让核心别继续排队。 */
  health?: () => BridgeHealth;
  /** 从本机镜像的 owner 找会话（重启后核心先回交付的场景）。 */
  chatFor?: (sender: string) => string | undefined;
  /** 测试注入；默认用官方 SDK 建客户端。 */
  createApi?: (app: LarkCredentials) => LarkApi;
  now?: () => number;
}

export interface LarkStack {
  readonly app: LarkCredentials;
  readonly api: LarkApi;
  readonly bridge: LarkBridge;
  readonly pipeline: InboundPipeline;
  readonly standalone: StandaloneChat;
  readonly sink: LarkEventSink;
  /** 主动给主人发一条纯文本（提醒用）；没有主人或发送失败时返回 false。 */
  notify(text: string): Promise<boolean>;
  dispose(): void;
}

export function createLarkStack(options: LarkStackOptions): LarkStack {
  const { app, logger } = options;
  const now = options.now ?? Date.now;
  const api =
    options.createApi?.(app) ??
    createSdkLarkApi({
      client: createSdkClient({ ...app, ...(logger === undefined ? {} : { logger }) }) as unknown as SdkClientLike,
      logger,
    });

  const bridge = createLarkBridge({
    account: app.appId,
    api,
    logger,
    maxText: options.config.maxText,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.health === undefined ? {} : { health: options.health }),
    ...(options.chatFor === undefined ? {} : { chatFor: options.chatFor }),
  });

  const standaloneOutbound = new OutboundChannel({
    api,
    maxText: options.config.maxText,
    logger,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const standalone = new StandaloneChat({
    outbound: standaloneOutbound,
    bindings: options.bindings,
    owners: options.owners,
    settings: options.settings,
    controller: options.controller,
    logger,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.ownerLabel === undefined ? {} : { ownerLabel: options.ownerLabel }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const pipeline = new InboundPipeline({
    api,
    bridge,
    logger,
    typing: options.typing ?? options.config.typingIndicator,
    ...(options.botOpenId === undefined ? {} : { botOpenId: options.botOpenId }),
    ...(options.ownerOpenId === undefined ? {} : { ownerOpenId: options.ownerOpenId }),
    ...(options.features === undefined ? {} : { features: options.features }),
    ...(options.isOwner === undefined ? {} : { isOwner: options.isOwner }),
    ...(options.onOwner === undefined ? {} : { onOwner: options.onOwner }),
    ...(options.claim === undefined ? {} : { claim: options.claim }),
    ...(options.now === undefined ? {} : { now: options.now }),
    fallback: (message, draft) => standalone.handleInbound(message, draft),
  });

  const sink: LarkEventSink = {
    onMessage: (envelope) => pipeline.handleMessage(envelope),
    onCardAction: (envelope) => pipeline.handleCardAction(envelope),
  };

  let sequence = 0;
  const notify = async (text: string): Promise<boolean> => {
    const owner = options.owners.peek();
    if (owner === null || owner.chatId === '') return false;
    const receipt = await standaloneOutbound.deliver({
      deliveryId: `reminder-${now()}-${(sequence += 1)}`,
      chatId: owner.chatId,
      text,
    });
    return receipt.errorCode === undefined;
  };

  return {
    app,
    api,
    bridge,
    pipeline,
    standalone,
    sink,
    notify,
    dispose: () => {
      bridge.dispose();
      void pipeline.drain();
    },
  };
}
