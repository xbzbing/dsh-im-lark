/**
 * Cordis 插件入口：只装配与接线。
 *
 * - 凭据在 `state/credentials.ts`，设置与静态配置在 `config.ts`；
 * - 长连接在 `lark/connection.ts`，OpenAPI 在 `lark/api.ts`（SDK 实现只在 `lark/sdk.ts`）；
 * - 运行期编排在 `runtime.ts`。
 *
 * `mySuperagent` 不写进顶层 `inject`：缺它的组合里插件仍应照常加载（只能走独立
 * 模式）。所以这里 `inject` 为空，可选服务用 `injectOptional` 接。
 */

import { LocalConfigStore, normalizePluginConfig } from './config.ts';
import type { PluginConfig } from './config.ts';
import { injectOptional, resolveLogger } from './host-context.ts';
import type { PluginContext } from './host-context.ts';
import { LarkConnection } from './lark/connection.ts';
import { sdkFactories } from './lark/sdk.ts';
import { LarkRuntime } from './runtime.ts';
import type { RuntimeStatus } from './runtime.ts';
import { CredentialStore } from './state/credentials.ts';
import { ensurePrivateDir } from './state/files.ts';

export type { PluginConfig, PluginContext };
export type { RuntimeStatus };
export { normalizePluginConfig } from './config.ts';
export { LarkRuntime } from './runtime.ts';

export const name = 'dsh-im-lark';

/** 没有硬依赖：核心、面板连接服务都按需接入。 */
export const inject: string[] = [];

/**
 * 插件入口。
 *
 * **必须返回 void。** Cordis 会把 `apply` 的返回值当作 effect 注册：返回一个普通
 * 对象会抛 `Invalid effect`，整个 fiber 直接 failed。运行期的启停一律交给
 * `ctx.effect` 注册的清理函数。
 */
export async function apply(ctx: PluginContext, config: PluginConfig | unknown = {}): Promise<void> {
  const logger = resolveLogger(ctx.logger, name);
  const normalized = normalizePluginConfig(config);

  await ensurePrivateDir(normalized.dataDir);

  const credentials = new CredentialStore({ dataDir: normalized.dataDir, logger });
  const settings = new LocalConfigStore({ dataDir: normalized.dataDir, config: normalized, logger });

  const runtime = new LarkRuntime({
    config: normalized,
    logger,
    credentials,
    settings,
    createConnection: (app) =>
      new LarkConnection({
        app,
        logger,
        createWsClient: sdkFactories.createWsClient,
        createDispatcher: sdkFactories.createDispatcher,
      }),
  });

  await runtime.start();

  ctx.effect?.(() => () => runtime.stop(), 'dsh-im-lark: 停止运行期');

  // 宿主里没有 mySuperagent 时不报错：只是「核心不可用」，面板据此禁用开关。
  injectOptional(ctx, 'mySuperagent', (scope) => {
    void scope;
    runtime.setCoreAvailable(true);
    scope.effect?.(() => () => runtime.setCoreAvailable(false), 'dsh-im-lark: 核心撤销');
  });

  logger.info?.(`飞书桥已加载（连接状态：${runtime.status().connection.state}）`);
}
