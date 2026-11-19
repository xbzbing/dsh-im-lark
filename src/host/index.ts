/**
 * Cordis 插件入口：只装配与接线。
 *
 * - 凭据在 `state/credentials.ts`，设置与静态配置在 `config.ts`；
 * - 长连接在 `lark/connection.ts`，OpenAPI 在 `lark/api.ts`（SDK 实现只在 `lark/sdk.ts`）；
 * - 运行期编排在 `runtime.ts`，一次连接的整套对象在 `stack.ts`。
 *
 * `mySuperagent` 不写进顶层 `inject`：缺它的组合里插件仍应照常加载（只能走独立
 * 模式）。所以这里 `inject` 为空，可选服务用 `injectOptional` 接。
 *
 * 注册顺序是硬约束：桥的 `account` 只有拿到凭据才知道，所以**先有连接上下文、
 * 再向核心注册**；核心晚于插件上线时，在注入回调里补注册。
 */

import { LocalConfigStore, normalizePluginConfig } from './config.ts';
import type { PluginConfig } from './config.ts';
import { injectOptional, resolveLogger } from './host-context.ts';
import type { PluginContext } from './host-context.ts';
import { LarkConnection } from './lark/connection.ts';
import { sdkFactories } from './lark/sdk.ts';
import type { LarkCredentials } from './lark/types.ts';
import type { BridgeHandle, MySuperagentService } from './protocol.ts';
import { LarkRuntime } from './runtime.ts';
import type { RuntimeStatus } from './runtime.ts';
import { createLarkStack } from './stack.ts';
import type { LarkStack } from './stack.ts';
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

  /** 当前连接的整套对象；凭据变化时整套重建。 */
  let stack: LarkStack | null = null;
  let service: MySuperagentService | undefined;
  let coreHandle: BridgeHandle | undefined;

  const registerCore = (): void => {
    if (service === undefined || stack === null || coreHandle !== undefined) return;
    coreHandle = service.bridges.register(stack.bridge.provider);
    stack.bridge.attach(coreHandle);
    logger.info?.('已接入「我的超级助理」');
  };

  const unregisterCore = (): void => {
    if (coreHandle === undefined) return;
    coreHandle = undefined;
    // detach 会 dispose 核心给的句柄，注册表随之摘掉 provider。
    stack?.bridge.detach();
    logger.info?.('已断开「我的超级助理」');
  };

  const teardown = (): void => {
    unregisterCore();
    runtime.setSink(undefined);
    stack?.dispose();
    stack = null;
  };

  const sync = (app: LarkCredentials | null): void => {
    if (app === null) {
      teardown();
      return;
    }
    if (stack !== null && sameApp(stack.app, app)) return;

    teardown();
    stack = createLarkStack({
      app,
      config: normalized,
      logger,
      typing: settings.current.typingIndicator,
      features: () => service?.protocol.features ?? [],
      botOpenId: () => undefined,
      ownerOpenId: () => undefined,
    });
    runtime.setSink(stack.sink);
    registerCore();
  };

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
    onChange: ({ app }) => sync(app),
  });

  // 先 start：onChange 里会建出第一份 stack 并接上事件去向。
  await runtime.start();

  ctx.effect?.(
    () => () => {
      runtime.stop();
      teardown();
    },
    'dsh-im-lark: 停止运行期',
  );

  // 宿主里没有 mySuperagent 时不报错：只是「核心不可用」，面板据此禁用开关。
  injectOptional(ctx, 'mySuperagent', (scope) => {
    const injected = scope.mySuperagent as MySuperagentService | undefined;
    if (injected === undefined) return;

    service = injected;
    runtime.setCoreAvailable(true);
    registerCore();

    scope.effect?.(
      () => () => {
        if (service === injected) service = undefined;
        runtime.setCoreAvailable(false);
        unregisterCore();
      },
      'dsh-im-lark: 核心撤销',
    );
  });

  logger.info?.(`飞书桥已加载（连接状态：${runtime.status().connection.state}）`);
}

function sameApp(a: LarkCredentials, b: LarkCredentials): boolean {
  return a.appId === b.appId && a.appSecret === b.appSecret && a.domain === b.domain;
}
