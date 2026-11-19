/**
 * 官方 SDK 的装配点。
 *
 * 这是**唯一** import `@larksuiteoapi/node-sdk` 的地方：其余模块都面向
 * `connection.ts` / `api.ts` 的端口。这样 SDK 升级只影响本文件，测试也不必
 * 真的建连接。
 */

import * as Lark from '@larksuiteoapi/node-sdk';

import type { Client, WSClient } from '@larksuiteoapi/node-sdk';

import type { EventDispatcherLike, WsClientLike } from './connection.ts';
import type { SdkClientLike } from './api.ts';
import type { LarkDomain } from './types.ts';

/** 把域收敛成 SDK 认识的域名串。 */
export function sdkDomainOf(domain: LarkDomain): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

/** 建 WSClient 的工厂。参数形状由 `LarkConnection` 传入（已收窄）。 */
function createWsClient(params: Record<string, unknown>): WsClientLike {
  return new Lark.WSClient(params as unknown as ConstructorParameters<typeof WSClient>[0]) as unknown as WsClientLike;
}

/** 建 EventDispatcher 的工厂。长连接模式下验证令牌与加密密钥都留空。 */
function createDispatcher(params: Record<string, unknown>): EventDispatcherLike {
  return new Lark.EventDispatcher(params as unknown as ConstructorParameters<typeof Lark.EventDispatcher>[0]);
}

/** 建 OpenAPI 客户端。 */
export function createSdkClient(input: { appId: string; appSecret: string; domain: LarkDomain }): SdkClientLike {
  return new Lark.Client({
    appId: input.appId,
    appSecret: input.appSecret,
    domain: sdkDomainOf(input.domain),
  }) as unknown as SdkClientLike;
}

export const sdkFactories = Object.freeze({ createWsClient, createDispatcher, createSdkClient });

/** 给入口用的便捷装配（后续里程碑接出站时使用）。 */
export function createSdkBridge(input: {
  appId: string;
  appSecret: string;
  domain: LarkDomain;
}): { client: Client } {
  return { client: createSdkClient(input) as unknown as Client };
}
