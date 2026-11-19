/**
 * 面板 RPC：宿主的 `connection.rpc` 通道，浏览器经 `connection.rpc.call` 访问。
 *
 * 端点一律「窄接口」：只接受字段明确的补丁对象，逐字段校验类型与范围，认不
 * 出来就回 `invalid-config`。浏览器发来的 JSON 是不可信输入，不把它直接塞进
 * 运行期，也不把内部错误原文透给页面（可能带本机路径）。
 *
 * 凭据只在保存时经过这里；读取只回 App ID 尾号（`RuntimeStatus.appIdTail`）。
 */

import { PANEL_CONTRACT, PLUGIN_VERSION, RPC_CHANNEL } from '../shared/version.ts';
import type { LocalConfigStore, NormalizedConfig } from './config.ts';
import { errorDetail, injectOptional } from './host-context.ts';
import type { PluginContext, PluginLogger, RpcResult } from './host-context.ts';
import type { LarkRuntime, RuntimeStatus } from './runtime.ts';
import type { CredentialStore } from './state/credentials.ts';
import { probeCredentials } from './state/credentials.ts';
import type { LarkCredentials, LarkCredentialCheck, LarkDomain } from './lark/types.ts';

export const ENDPOINTS = Object.freeze({
  STATUS: 'status',
  CREDENTIALS_SAVE: 'credentials.save',
  CREDENTIALS_CLEAR: 'credentials.clear',
  PROBE: 'probe',
  SETTINGS_SET: 'settings.set',
  RECONNECT: 'reconnect',
} as const);

export type Endpoint = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];

export interface PanelDeps {
  runtime: LarkRuntime;
  credentials: CredentialStore;
  settings: LocalConfigStore;
  config: NormalizedConfig;
  logger: PluginLogger;
  /** 自检成功时把机器人身份交回入口（@ 提及需要它）；带上是哪个 App。 */
  onProbe?: (check: LarkCredentialCheck, app: LarkCredentials) => void;
  /** 测试注入；默认用真实网络。 */
  probe?: typeof probeCredentials;
}

interface CodedError extends Error {
  code: string;
}

function codedError(message: string, code: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function bad(code: string, message: string): RpcResult<never> {
  return { ok: false, error: { code, message, details: {} } };
}

/** 面板一次读取的快照：只放能安全展示的字段。 */
export interface PanelSnapshot {
  contract: number;
  pluginVersion: string;
  status: RuntimeStatus;
  settings: {
    enabled: boolean;
    superagent: boolean;
    typingIndicator: boolean;
    replyStatus: boolean;
  };
  config: {
    domain: LarkDomain;
    maxText: number;
    rpcChannel: string;
  };
  /** 已配置时只回尾号；未配置为 null。 */
  appIdTail: string | null;
}

export function snapshotOf(deps: PanelDeps): PanelSnapshot {
  const settings = deps.settings.current;
  const status = deps.runtime.status();
  return {
    contract: PANEL_CONTRACT,
    pluginVersion: PLUGIN_VERSION,
    status,
    settings: {
      enabled: settings.enabled,
      superagent: settings.superagent,
      typingIndicator: settings.typingIndicator,
      replyStatus: settings.replyStatus,
    },
    config: {
      domain: status.domain,
      maxText: deps.config.maxText,
      rpcChannel: RPC_CHANNEL,
    },
    appIdTail: status.appIdTail,
  };
}

export async function handleEndpoint(deps: PanelDeps, endpoint: string, payload: unknown): Promise<unknown> {
  switch (endpoint) {
    case ENDPOINTS.STATUS:
      return snapshotOf(deps);

    case ENDPOINTS.CREDENTIALS_SAVE: {
      const input = payloadOf(payload);
      const appId = textOf(input.appId);
      const filled = textOf(input.appSecret);
      const domain = domainOf(input.domain) ?? deps.config.domain;
      if (appId === undefined) throw codedError('App ID 不能为空', 'invalid-config');
      // App ID 会作为桥的 account 被核心校验：形状不对要在这里拒绝，不能拖到注册时。
      if (!/^[\w.@-]{1,128}$/u.test(appId)) throw codedError('App ID 格式不正确', 'invalid-config');

      // 留空表示「沿用已保存的 Secret」：面板不回显密钥，改 App ID 时不必重输。
      const appSecret = filled ?? (await deps.credentials.load())?.appSecret;
      if (appSecret === undefined) throw codedError('App Secret 不能为空', 'invalid-config');

      const app: LarkCredentials = { appId, appSecret, domain };
      await deps.credentials.save(app);
      await deps.runtime.reloadCredentials();
      return snapshotOf(deps);
    }

    case ENDPOINTS.CREDENTIALS_CLEAR: {
      await deps.credentials.clear();
      await deps.runtime.reloadCredentials();
      return snapshotOf(deps);
    }

    case ENDPOINTS.PROBE: {
      const input = payloadOf(payload);
      const stored = await deps.credentials.load();
      const appId = textOf(input.appId) ?? stored?.appId;
      const appSecret = textOf(input.appSecret) ?? stored?.appSecret;
      const domain = domainOf(input.domain) ?? stored?.domain ?? deps.config.domain;
      if (appId === undefined || appSecret === undefined) {
        throw codedError('先填写 App ID 与 App Secret', 'invalid-config');
      }
      const probe = deps.probe ?? probeCredentials;
      const app: LarkCredentials = { appId, appSecret, domain };
      const result: LarkCredentialCheck = await probe({ app });
      deps.onProbe?.(result, app);
      return { check: result };
    }

    case ENDPOINTS.SETTINGS_SET: {
      const input = payloadOf(payload);
      const patch: Record<string, unknown> = {};

      for (const key of ['enabled', 'superagent', 'typingIndicator', 'replyStatus'] as const) {
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'boolean') throw codedError(`${key} 必须是布尔值`, 'invalid-config');
          patch[key] = input[key];
        }
      }
      if (Object.keys(patch).length === 0) throw codedError('没有要保存的设置', 'invalid-config');

      await deps.runtime.applySettings(patch as never);
      return snapshotOf(deps);
    }

    case ENDPOINTS.RECONNECT: {
      await deps.runtime.reconnect();
      return snapshotOf(deps);
    }

    default:
      throw codedError(`未知的面板端点：${endpoint}`, 'unknown-endpoint');
  }
}

/** 注册 RPC 通道；宿主没有 connection 服务时静默跳过（CLI/桌面组合）。 */
export function registerPanelRpc(ctx: PluginContext, deps: PanelDeps): void {
  const install = (scope: PluginContext): void => {
    const connection = scope.connection;
    if (connection === undefined || typeof connection.rpc?.handle !== 'function') {
      deps.logger.warn?.('面板 RPC 未注册：宿主未提供 connection.rpc');
      return;
    }

    const handler = async (endpoint: string, payload: unknown): Promise<RpcResult<unknown>> => {
      try {
        return ok(await handleEndpoint(deps, endpoint, payload));
      } catch (error) {
        deps.logger.warn?.(`面板 RPC 失败 endpoint=${endpoint}`, errorDetail(error));
        if (typeof (error as CodedError).code === 'string') {
          return bad((error as CodedError).code, (error as Error).message);
        }
        return bad('internal', '面板操作失败');
      }
    };

    const register = (): (() => Promise<void>) => {
      const dispose = connection.rpc.handle(RPC_CHANNEL, handler);
      return () => Promise.resolve(dispose());
    };

    if (typeof scope.effect === 'function') {
      scope.effect(() => {
        const dispose = register();
        return () => {
          void dispose();
        };
      }, 'dsh-im-lark: 面板 RPC');
    } else {
      void register();
    }
  };

  injectOptional(ctx, 'connection', install);
}

function payloadOf(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function domainOf(value: unknown): LarkDomain | undefined {
  return value === 'lark' || value === 'feishu' ? value : undefined;
}
