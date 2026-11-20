/**
 * 官方 SDK 的装配点。
 *
 * 这是**唯一** import `@larksuiteoapi/node-sdk` 的地方：其余模块都面向
 * `connection.ts` / `api.ts` 的端口。这样 SDK 升级只影响本文件，测试也不必
 * 真的建连接。
 *
 * SDK 是单文件约 6 MB 的 bundle（约 1400 个接口都在一个文件里，没法 tree-shake），
 * 顶层 `import` 会让每个没配飞书的宿主都白付一次解析与常驻。这里改成**首次真正
 * 用到时才 require**：端口签名保持同步，装配链不用为了懒加载改成 async。
 */

import { createRequire } from 'node:module';

import type { Client } from '@larksuiteoapi/node-sdk';

import { sdkLogger } from './connection.ts';
import type { EventDispatcherLike, LarkLogger, WsClientLike } from './connection.ts';
import type { SdkClientLike } from './api.ts';
import type { LarkDomain } from './types.ts';

/** 把域收敛成 SDK 认识的域名串。 */
export function sdkDomainOf(domain: LarkDomain): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

type LarkSdk = typeof import('@larksuiteoapi/node-sdk');

const nodeRequire = createRequire(import.meta.url);

let loaded: LarkSdk | undefined;

/** 取 SDK 模块：第一次调用时才解析，之后复用同一份。 */
function sdk(): LarkSdk {
  loaded ??= nodeRequire('@larksuiteoapi/node-sdk') as LarkSdk;
  return loaded;
}

/** 建 WSClient 的工厂。参数形状由 `LarkConnection` 传入（已收窄）。 */
function createWsClient(params: Record<string, unknown>): WsClientLike {
  const Lark = sdk();
  return new Lark.WSClient(
    params as unknown as ConstructorParameters<typeof Lark.WSClient>[0],
  ) as unknown as WsClientLike;
}

/** 建 EventDispatcher 的工厂。长连接模式下验证令牌与加密密钥都留空。 */
function createDispatcher(params: Record<string, unknown>): EventDispatcherLike {
  const Lark = sdk();
  return new Lark.EventDispatcher(
    params as unknown as ConstructorParameters<typeof Lark.EventDispatcher>[0],
  );
}

/** 建 OpenAPI 客户端。`logger` 不传就落回 SDK 自带的 console 实现。 */
export function createSdkClient(input: {
  appId: string;
  appSecret: string;
  domain: LarkDomain;
  logger?: LarkLogger;
}): SdkClientLike {
  const Lark = sdk();
  return new Lark.Client({
    appId: input.appId,
    appSecret: input.appSecret,
    domain: sdkDomainOf(input.domain),
    logger: sdkLogger(input.logger),
  }) as unknown as SdkClientLike;
}

export const sdkFactories = Object.freeze({ createWsClient, createDispatcher, createSdkClient });

/**
 * 一键创建应用（扫码授权）。
 *
 * 与 `Client` 不同，`registerApp` 的 `domain` 要的是**主机名**而不是带 scheme 的
 * 地址；默认值是 `accounts.feishu.cn`，这里按平台显式给。
 */
export interface AppRegistrationRequest {
  domain: LarkDomain;
  signal: AbortSignal;
  onUrl: (info: { url: string; expireIn: number }) => void;
}

export interface AppRegistrationResult {
  appId: string;
  appSecret: string;
}

export async function registerApp(input: AppRegistrationRequest): Promise<AppRegistrationResult> {
  const result = await sdk().registerApp({
    domain: input.domain === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn',
    source: 'dsh-im-lark',
    signal: input.signal,
    onQRCodeReady: (info) => input.onUrl({ url: info.url, expireIn: info.expireIn }),
  });
  return { appId: result.client_id, appSecret: result.client_secret };
}

/** 给入口用的便捷装配（后续里程碑接出站时使用）。 */
export function createSdkBridge(input: {
  appId: string;
  appSecret: string;
  domain: LarkDomain;
}): { client: Client } {
  return { client: createSdkClient(input) as unknown as Client };
}
