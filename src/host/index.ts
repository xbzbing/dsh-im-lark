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
import { probeCredentials } from './state/credentials.ts';
import type { PluginConfig } from './config.ts';
import { injectOptional, resolveLogger } from './host-context.ts';
import type { PluginContext } from './host-context.ts';
import { LarkConnection } from './lark/connection.ts';
import { registerLarkCommand } from './command.ts';
import { registerPanelRpc } from './panel-host.ts';
import { registerApp, sdkFactories } from './lark/sdk.ts';
import { AppRegistration } from './registration.ts';
import type { LarkCredentials } from './lark/types.ts';
import type { BridgeHandle, BridgeHealth, MySuperagentService } from './protocol.ts';
import { LarkRuntime } from './runtime.ts';
import type { RuntimeStatus } from './runtime.ts';
import { createLarkStack } from './stack.ts';
import type { LarkStack } from './stack.ts';
import { CredentialStore } from './state/credentials.ts';
import { DirectBindingStore, OwnerStore } from './state/direct.ts';
import type { StandaloneController } from './standalone.ts';
import { ensurePrivateDir } from './state/files.ts';
import { resolveDefaultWorkspace } from './state/paths.ts';
import { ReminderCenter } from './reminders.ts';
import type { QuestionNext, QuestionRequest } from './questions.ts';
import type { ApprovalNext } from './approvals.ts';
import type { ApprovalRequest } from './reminder-text.ts';
import { Workspaces } from './workspaces.ts';
import type { WorkspaceRegistry } from './workspaces.ts';

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
 * **不得返回普通对象。** Cordis 会把 `apply` 的返回值当作 effect 注册：返回一个
 * 普通对象会抛 `Invalid effect`，整个 fiber 直接 failed。异步初始化放在清理函数
 * 登记之后；运行期的启停一律交给 `ctx.effect` 注册的清理函数。
 */
export async function apply(ctx: PluginContext, config: PluginConfig | unknown = {}): Promise<void> {
  const logger = resolveLogger(ctx.logger, name);
  const normalized = normalizePluginConfig(config);

  const credentials = new CredentialStore({ dataDir: normalized.dataDir, logger });
  const settings = new LocalConfigStore({ dataDir: normalized.dataDir, config: normalized, logger });
  const bindings = new DirectBindingStore({ dataDir: normalized.dataDir, logger });
  const owners = new OwnerStore({ dataDir: normalized.dataDir, logger });
  // 默认工作区目录与状态目录分开：会话的 cwd 不该能读到 App Secret。
  const workspaces = new Workspaces({ dir: resolveDefaultWorkspace(), logger });

  /** 当前连接的整套对象；凭据变化时整套重建。 */
  let stack: LarkStack | null = null;
  let service: MySuperagentService | undefined;
  let coreHandle: BridgeHandle | undefined;
  let controller: StandaloneController | null = null;
  /** 机器人自己的 open_id：@ 提及要靠它区分「@机器人」与「@别人」。 */
  let botOpenId: string | undefined;
  /** 这个 open_id 属于哪个 App：换应用/晚到的自检不能覆盖。 */
  let botOpenIdFor: string | undefined;

  /** 当前是否应该把消息交给核心（面板开关开 + 服务在）。 */
  const coreEnabled = (): boolean => service !== undefined && settings.current.superagent;

  const registerCore = (): void => {
    if (!coreEnabled() || stack === null || coreHandle !== undefined) return;
    try {
      const handle = service!.bridges.register(stack.bridge.provider);
      coreHandle = handle;
      stack.bridge.attach(handle);
      logger.info?.('已接入「我的超级助理」');
    } catch (error) {
      // account 形状不合法、同一 account 重复注册等；不把插件带崩，面板仍可见。
      logger.warn?.('接入「我的超级助理」失败', error instanceof Error ? error.message : String(error));
    }
  };

  const unregisterCore = (): void => {
    if (coreHandle === undefined) return;
    coreHandle = undefined;
    // detach 会 dispose 核心给的句柄，注册表随之摘掉 provider。
    stack?.bridge.detach();
    logger.info?.('已断开「我的超级助理」');
  };

  /**
   * 两种模式互斥：开关开着且服务在才把消息交给核心，否则走独立模式。
   * 注册/摘除都做成幂等，凭据重建后可以按当前模式重新接上。
   */
  const applyRouting = (): void => {
    if (coreEnabled()) {
      registerCore();
      // 接入核心后由核心发卡片；在等的提醒交回 Web，避免两边同时打扰。
      reminders.cancelAll('已接入核心，由核心处理');
    } else {
      unregisterCore();
    }
  };

  const teardown = (): void => {
    unregisterCore();
    // 连接要重建：在等的提醒先交回 Web，别让主人对着一条不会再被接收的提醒作答。
    reminders.cancelAll('飞书连接已重建');
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
    if (botOpenIdFor !== app.appId) {
      botOpenId = undefined;
      botOpenIdFor = app.appId;
    }
    stack = createLarkStack({
      app,
      config: normalized,
      logger,
      typing: settings.current.typingIndicator,
      // 独立模式也要下载媒体：核心的 features 只在核心模式下有意义。
      features: () => (coreEnabled() ? service?.protocol.features ?? [] : ['owner-images', 'owner-files']),
      // 核心声明 owner-lookup 时，非主人消息不下载媒体；没有核心/没有该能力时交给独立模式自己判。
      onOwner: (sender, chatId, chatType) => {
        // 主动发送优先单聊：群里说话只更新「还没有任何会话」时的兜底。
        const current = owners.peek();
        if (current !== null && current.openId === sender && chatType !== 'p2p') return;
        void owners.remember(sender, chatId).catch((error: unknown) => {
          logger.debug?.('镜像主人身份失败', error instanceof Error ? error.message : String(error));
        });
      },
      isOwner: (sender) => {
        if (!coreEnabled() || service?.protocol.features?.includes('owner-lookup') !== true) return undefined;
        try {
          return coreHandle?.isOwner(sender);
        } catch {
          // 核心判定失败时退回「先收下」，别让一条消息卡死整条队列。
          return undefined;
        }
      },
      botOpenId: () => botOpenId,
      ownerOpenId: () => owners.peek()?.openId,
      chatFor: (sender) => {
        const owner = owners.peek();
        return owner !== null && owner.openId === sender ? owner.chatId : undefined;
      },
      settings: () => settings.current,
      bindings,
      owners,
      controller: () => controller,
      workspaceId: () => workspaces.defaultId,
      // 提醒的作答先于普通消息：主人回「批准」「2」时不该把它当聊天送进会话。
      claim: (draft) =>
        !coreEnabled() &&
        (draft.images?.length ?? 0) === 0 &&
        (draft.files?.length ?? 0) === 0 &&
        reminders.reply(draft.text),
      ownerLabel: () => tailOf(app.appId),
      health: () => bridgeHealth(runtime.status().connection.state),
    });
    runtime.setSink(stack.sink);
    applyRouting();
    // 连接关着的时候不查：测试与纯离线环境不该因为一次自检去联网。
    if (settings.current.enabled) void learnBotIdentity(app);
  };

  /** 查一次机器人身份：@ 提及要靠它区分「@机器人」与「@别人」；失败只降级不报错。 */
  const learnBotIdentity = async (app: LarkCredentials): Promise<void> => {
    try {
      const check = await probeCredentials({ app });
      if (check.ok && check.botOpenId !== undefined && check.botOpenId !== '' && botOpenIdFor === app.appId) {
        botOpenId = check.botOpenId;
      }
    } catch (error) {
      logger.debug?.('读取机器人身份失败', error instanceof Error ? error.message : String(error));
    }
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
    onSettings: (saved) => {
      applyRouting();
      reminders.configure({ enabled: saved.questionReminders, delayMinutes: saved.questionDelayMinutes });
    },
  });

  /**
   * 问题与审批提醒。
   *
   * 只在独立模式接管：接入核心后由核心发卡片，再提醒一次会打扰两遍。发送目标只认
   * 主人单聊（`owners` 里记的 chatId 只来自单聊），没有主人时 broker 会原样 `next()`。
   */
  const reminders = new ReminderCenter({
    send: async (text) => (stack === null ? false : stack.notify(text)),
    recipient: () => owners.peek()?.openId ?? null,
    isActive: () => !coreEnabled() && runtime.active && stack !== null,
    enabled: normalized.questionReminders,
    delayMinutes: normalized.questionDelayMinutes,
    logger,
  });

  // 扫码创建应用：凭据只在 SDK 授权成功后才落盘，再让运行期按新凭据重连。
  const registration = new AppRegistration({
    start: (input) => registerApp(input),
    save: async (app) => {
      await credentials.save(app);
    },
    reload: () => runtime.reloadCredentials(),
    logger,
  });

  // 先登记清理，再跑异步初始化：启动失败或宿主提前卸载都不会留下半截运行期。
  ctx.effect?.(
    () => () => {
      reminders.close();
      runtime.stop();
      teardown();
    },
    'dsh-im-lark: 停止运行期',
  );

  // 注入回调可能在 apply 返回前同步触发（宿主里服务已就绪），而路由要读设置；
  // 先读一次。读失败只记日志，runtime.start() 还会再读，面板也能看到默认值。
  await settings.load().catch((error: unknown) => {
    logger.warn?.('读取本地设置失败，先按默认值运行', error instanceof Error ? error.message : String(error));
  });

  // 宿主里没有 mySuperagent 时不报错：只是「核心不可用」，面板据此禁用开关。
  injectOptional(ctx, 'mySuperagent', (scope) => {
    const injected = scope.mySuperagent as MySuperagentService | undefined;
    if (injected === undefined) return;

    service = injected;
    runtime.setCoreAvailable(true);
    applyRouting();

    scope.effect?.(
      () => () => {
        if (service === injected) service = undefined;
        runtime.setCoreAvailable(false);
        unregisterCore();
      },
      'dsh-im-lark: 核心撤销',
    );
  });

  // 独立模式的会话控制器：宿主没有它时独立模式整体不可用（面板上看不到开关）。
  injectOptional(ctx, 'sessionController', (scope) => {
    controller = (scope.sessionController as StandaloneController | undefined) ?? null;
    scope.effect?.(() => () => {
      controller = null;
    }, 'dsh-im-lark: 解挂会话控制器');
  });

  // 独立模式的默认工作区：宿主工作区服务在时自动建一个「飞书会话」目录。
  injectOptional(ctx, 'workspaceRegistry', (scope) => {
    workspaces.attach((scope.workspaceRegistry as WorkspaceRegistry | undefined) ?? null);
    scope.effect?.(() => () => {
      workspaces.attach(null);
    }, 'dsh-im-lark: 解挂工作区');
  });

  // 所有会话的事件都要收到：独立模式只处理自己绑定的那个，其余忽略。
  if (typeof ctx.on === 'function') {
    ctx.on(
      'session/event',
      ((session: unknown, event: unknown) => {
        const id = typeof session === 'string' ? session : ((session as { id?: unknown } | null)?.id ?? '');
        if (typeof id === 'string' && id !== '') stack?.standalone.handleEvent(id, event);
      }) as unknown as (...args: unknown[]) => void,
      { global: true },
    );

    // 提问与审批必须 prepend：Web 端的转发监听器在 Host 启动时就注册了，排在它
    // 后面永远轮不到我们。不接管时原样 next()，行为与没装插件一致。
    ctx.on(
      'user-questions/request',
      ((request: unknown, next: () => Promise<unknown>) =>
        reminders.handleQuestion(
          request as QuestionRequest,
          next as QuestionNext,
          !coreEnabled() && runtime.active && stack !== null,
        )) as unknown as (...args: unknown[]) => void,
      { prepend: true },
    );
    ctx.on(
      'approval/request',
      ((request: unknown, next: () => Promise<unknown>) =>
        reminders.handleApproval(
          request as ApprovalRequest,
          next as ApprovalNext,
          !coreEnabled() && runtime.active && stack !== null,
        )) as unknown as (...args: unknown[]) => void,
      { prepend: true },
    );
  }

  registerPanelRpc(ctx, {
    runtime,
    credentials,
    settings,
    config: normalized,
    registration,
    workspaces,
    reminders,
    logger,
    onProbe: (check, app) => {
      if (check.ok && check.botOpenId !== undefined && check.botOpenId !== '' && stack?.app.appId === app.appId) {
        botOpenId = check.botOpenId;
        botOpenIdFor = app.appId;
      }
    },
  });

  registerLarkCommand(ctx, {
    logger,
    sendText: async (text) => {
      if (stack === null) return { ok: false, error: '先在插件面板里配置飞书应用凭据。' };
      return stack.standalone.sendText(text);
    },
    statusText: () => {
      const status = runtime.status();
      const app = status.appIdTail === null ? '未配置' : `…${status.appIdTail}`;
      const owner = owners.peek();
      return [
        `应用：${app}（${status.domain === 'lark' ? 'Lark' : '飞书'}）`,
        `连接：${status.connection.state}`,
        `收件人：${owner === null ? '还没有主人（先在飞书里私聊机器人）' : '已绑定'}`,
      ].join('\n');
    },
  });

  try {
    await ensurePrivateDir(normalized.dataDir);
    // 提前读一次主人身份：重启后核心可能在下一条入站消息之前就回交付。
    await owners.get();
  } catch (error) {
    logger.error?.('初始化状态目录失败', error instanceof Error ? error.message : String(error));
  }

  // start 内部会走 onChange 建出第一份 stack 并接上事件去向。
  await runtime.start().catch((error: unknown) => {
    logger.error?.('运行期启动失败', error instanceof Error ? error.message : String(error));
  });

  logger.info?.(`飞书桥已加载（连接状态：${runtime.status().connection.state}）`);
}

/** App ID 尾号：建会话标题用，避免把完整 id 写进会话名。 */
function tailOf(appId: string): string {
  return appId.length > 6 ? appId.slice(-6) : appId;
}

function sameApp(a: LarkCredentials, b: LarkCredentials): boolean {
  return a.appId === b.appId && a.appSecret === b.appSecret && a.domain === b.domain;
}

/** 连接状态 → 核心可理解的健康度：断线时别让核心继续排队。 */
function bridgeHealth(state: string): BridgeHealth {
  switch (state) {
    case 'connected':
      return { state: 'ok' };
    case 'failed':
      return { state: 'down', code: 'network', reason: '飞书长连接已断开' };
    case 'connecting':
    case 'reconnecting':
      return { state: 'degraded', code: 'network', reason: '飞书长连接正在重连' };
    default:
      return { state: 'down', code: 'other', reason: '飞书长连接未启动' };
  }
}
