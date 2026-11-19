/**
 * 一次连接对应的整套对象：OpenAPI 客户端、桥、入站流水线、事件去向。
 *
 * 凭据换了就必须整套重建（客户端里缓存着 token），所以这里做成工厂而不是
 * 在入口里逐个 new。核心连上来/断开的注册动作不在这里做：那属于协议接线，
 * 由入口统一处理，`stack` 只保证「有一份可用的桥」。
 */

import type { NormalizedConfig } from './config.ts';
import { createLarkBridge } from './bridge.ts';
import type { LarkBridge } from './bridge.ts';
import { InboundPipeline } from './inbound-pipeline.ts';
import { createSdkLarkApi } from './lark/api.ts';
import type { LarkApi, SdkClientLike } from './lark/api.ts';
import type { LarkLogger } from './lark/connection.ts';
import { createSdkClient } from './lark/sdk.ts';
import type { LarkCredentials } from './lark/types.ts';
import type { LarkEventSink } from './runtime.ts';

export interface LarkStackOptions {
  app: LarkCredentials;
  config: NormalizedConfig;
  logger: LarkLogger;
  /** 收到消息是否打表情；来自面板设置。 */
  typing?: boolean;
  botOpenId?: () => string | undefined;
  ownerOpenId?: () => string | undefined;
  features?: () => readonly string[];
  /** 测试注入；默认用官方 SDK 建客户端。 */
  createApi?: (app: LarkCredentials) => LarkApi;
  now?: () => number;
}

export interface LarkStack {
  readonly app: LarkCredentials;
  readonly api: LarkApi;
  readonly bridge: LarkBridge;
  readonly pipeline: InboundPipeline;
  readonly sink: LarkEventSink;
  dispose(): void;
}

export function createLarkStack(options: LarkStackOptions): LarkStack {
  const { app, logger } = options;
  const api =
    options.createApi?.(app) ??
    createSdkLarkApi({
      client: createSdkClient(app) as unknown as SdkClientLike,
      logger,
    });

  const bridge = createLarkBridge({
    account: app.appId,
    api,
    logger,
    maxText: options.config.maxText,
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
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const sink: LarkEventSink = {
    onMessage: (envelope) => pipeline.handleMessage(envelope),
    onCardAction: (envelope) => pipeline.handleCardAction(envelope),
  };

  return {
    app,
    api,
    bridge,
    pipeline,
    sink,
    dispose: () => {
      bridge.dispose();
      void pipeline.drain();
    },
  };
}
