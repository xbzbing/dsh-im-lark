/**
 * 面板 RPC：挂一条 `POST /api/dsh-im-lark` 的 exact 路由，浏览器用
 * `connection.rpc.call('/api', 'dsh-im-lark', { method, payload })` 访问。
 *
 * 信封与宿主其它插件一致：请求 `{type:'client-request', rpcId, method, payload}`，
 * 响应 `{type:'server-response', rpcId, result:{ok, value|error}}`。
 *
 * 端点一律「窄接口」：只接受字段明确的补丁对象，逐字段校验类型与范围，认不
 * 出来就回 `invalid-config`。浏览器发来的 JSON 是不可信输入，不把它直接塞进
 * 运行期，也不把内部错误原文透给页面（可能带本机路径）。
 *
 * 凭据只在保存时经过这里；读取只回 App ID 尾号（`RuntimeStatus.appIdTail`）。
 */

import { PANEL_CONTRACT, PLUGIN_VERSION, RPC_CHANNEL, RPC_ENDPOINT, RPC_PREFIX } from '../shared/version.ts';
import { normalizeQuestionDelayMinutes } from './config.ts';
import type { LocalConfigStore, NormalizedConfig } from './config.ts';
import { errorDetail, injectOptional } from './host-context.ts';
import type { ConnectionLike, PluginContext, PluginLogger, RpcResult } from './host-context.ts';
import type { ReminderCenter } from './reminders.ts';
import type { LarkRuntime, RuntimeStatus } from './runtime.ts';
import type { Workspaces } from './workspaces.ts';
import type { CredentialStore } from './state/credentials.ts';
import { probeCredentials } from './state/credentials.ts';
import type { LarkCredentials, LarkCredentialCheck, LarkDomain } from './lark/types.ts';
import type { AppRegistration } from './registration.ts';

export const ENDPOINTS = Object.freeze({
  STATUS: 'status',
  CREDENTIALS_SAVE: 'credentials.save',
  CREDENTIALS_CLEAR: 'credentials.clear',
  PROBE: 'probe',
  SETTINGS_SET: 'settings.set',
  WORKSPACES_LIST: 'workspaces.list',
  RECONNECT: 'reconnect',
  REGISTER_START: 'register.start',
  REGISTER_POLL: 'register.poll',
  REGISTER_CANCEL: 'register.cancel',
} as const);

export type Endpoint = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];

/** 路由路径：宿主的 exact fetch 路由挂在 `/api` 下。 */
export const RPC_PATH = `${RPC_PREFIX}${RPC_CHANNEL}`;

/** 客户端 `rpc.call` 的 endpoint 段：与客户端共享同一份常量。 */
export { RPC_ENDPOINT };

export interface PanelDeps {
  runtime: LarkRuntime;
  credentials: CredentialStore;
  settings: LocalConfigStore;
  config: NormalizedConfig;
  registration: AppRegistration;
  /** 工作区候选与独立模式的默认工作区。 */
  workspaces: Workspaces;
  /** 问题与审批提醒的开关、等待时间与待答数。 */
  reminders: ReminderCenter;
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
    /** 独立模式：回合进行中收到新消息时插话（true）还是排队（false）。 */
    directBusyMode: 'queue' | 'steer';
    /** 独立模式选定的工作区；空串表示插件自动创建的默认工作区。 */
    directWorkspaceId: string;
    questionReminders: boolean;
    questionDelayMinutes: number;
  };
  /** 提醒的待答数与最近错误：面板据此显示「有 N 条在等」。 */
  reminders: {
    pendingQuestions: number;
    pendingApprovals: number;
    lastError?: { at: number; message: string };
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
  const reminders = deps.reminders.status();
  return {
    contract: PANEL_CONTRACT,
    pluginVersion: PLUGIN_VERSION,
    status,
    settings: {
      enabled: settings.enabled,
      superagent: settings.superagent,
      typingIndicator: settings.typingIndicator,
      replyStatus: settings.replyStatus,
      directBusyMode: settings.directBusyMode,
      directWorkspaceId: settings.directWorkspaceId,
      questionReminders: settings.questionReminders,
      questionDelayMinutes: settings.questionDelayMinutes,
    },
    reminders: {
      pendingQuestions: reminders.pendingQuestions,
      pendingApprovals: reminders.pendingApprovals,
      ...(reminders.lastError === undefined ? {} : { lastError: reminders.lastError }),
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

      for (const key of ['enabled', 'superagent', 'typingIndicator', 'replyStatus', 'questionReminders'] as const) {
        if (input[key] !== undefined) {
          if (typeof input[key] !== 'boolean') throw codedError(`${key} 必须是布尔值`, 'invalid-config');
          patch[key] = input[key];
        }
      }

      if (input.questionDelayMinutes !== undefined) {
        const value = normalizeQuestionDelayMinutes(input.questionDelayMinutes);
        if (value === undefined) throw codedError('提醒延迟必须是 0–120 的整数分钟', 'invalid-config');
        patch.questionDelayMinutes = value;
      }

      if (input.directBusyMode !== undefined) {
        if (input.directBusyMode !== 'steer' && input.directBusyMode !== 'queue') {
          throw codedError('回合提交方式只能是 steer 或 queue', 'invalid-config');
        }
        patch.directBusyMode = input.directBusyMode;
      }

      if (input.directWorkspaceId !== undefined) {
        if (typeof input.directWorkspaceId !== 'string') throw codedError('工作区 id 必须是字符串', 'invalid-config');
        const wanted = input.directWorkspaceId.trim();
        const catalog = deps.workspaces.catalog();
        // 选中的是插件自动创建的默认工作区：存空串，重建后仍指向默认。默认工作区
        // 不一定出现在宿主列表里（列表服务可能只列用户自己建的），所以先认它。
        const isDefault = wanted === '' || (catalog.defaultId !== '' && wanted === catalog.defaultId);
        if (!isDefault) {
          if (!catalog.available) throw codedError(catalog.reason ?? '宿主不提供工作区服务', 'invalid-config');
          if (!catalog.items.some((workspace) => workspace.id === wanted)) {
            throw codedError('选择的工作区不存在', 'invalid-config');
          }
        }
        patch.directWorkspaceId = isDefault ? '' : wanted;
      }

      if (Object.keys(patch).length === 0) throw codedError('没有要保存的设置', 'invalid-config');

      await deps.runtime.applySettings(patch as never);
      return snapshotOf(deps);
    }

    case ENDPOINTS.WORKSPACES_LIST:
      return deps.workspaces.catalog();

    case ENDPOINTS.REGISTER_START: {
      const input = payloadOf(payload);
      const domain = domainOf(input.domain) ?? deps.config.domain;
      return { registration: await deps.registration.start(domain) };
    }

    case ENDPOINTS.REGISTER_POLL:
      return { registration: deps.registration.poll() };

    case ENDPOINTS.REGISTER_CANCEL:
      return { registration: deps.registration.cancel() };

    case ENDPOINTS.RECONNECT: {
      await deps.runtime.reconnect();
      return snapshotOf(deps);
    }

    default:
      throw codedError(`未知的面板端点：${endpoint}`, 'unknown-endpoint');
  }
}

/**
 * 同路径路由在进程内唯一；状态挂到 `globalThis`，HMR 重载时新旧模块实例共享它。
 *
 * 重载重叠期新实例只接管 `handler`，不重复注册（重复注册宿主会抛“路由已存在”）；
 * 摘路由由真正注册它的实例负责，且只在自己仍是当前 handler 时清空。
 */
interface PanelRoute {
  handler: ((request: Request) => Promise<Response>) | null;
  off: (() => void) | null;
}

const ROUTE_KEY = Symbol.for('dsh-im-lark:panel-route');

function panelRoute(): PanelRoute {
  const globals = globalThis as unknown as Record<symbol, PanelRoute | undefined>;
  const existing = globals[ROUTE_KEY];
  if (existing !== undefined) return existing;
  const created: PanelRoute = { handler: null, off: null };
  globals[ROUTE_KEY] = created;
  return created;
}

function responseOf(body: unknown): Response {
  return Response.json(body);
}

function envelopeResponse(rpcId: string, result: RpcResult<unknown>): Response {
  return responseOf({ type: 'server-response', rpcId, result });
}

/** 注册面板路由；宿主没有 connection.fetch 时静默跳过（CLI/桌面组合）。 */
export function registerPanelRpc(ctx: PluginContext, deps: PanelDeps): void {
  const install = (scope: PluginContext): void => {
    const connection = scope.connection;

    const dispatch = async (request: Request): Promise<Response> => {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }

      let envelope: unknown;
      try {
        envelope = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }

      const record = typeof envelope === 'object' && envelope !== null ? (envelope as Record<string, unknown>) : {};
      const rpcId = typeof record.rpcId === 'string' ? record.rpcId : 'invalid-request';
      const call = record.payload;
      const callRecord = typeof call === 'object' && call !== null ? (call as Record<string, unknown>) : {};
      const endpoint = typeof callRecord.method === 'string' ? callRecord.method : '';
      const invalid =
        record.type !== 'client-request' || typeof record.rpcId !== 'string' || record.method !== RPC_ENDPOINT || endpoint === '';
      if (invalid) return envelopeResponse(rpcId, bad('bad-request', '面板请求格式不合法'));

      try {
        return envelopeResponse(rpcId, ok(await handleEndpoint(deps, endpoint, callRecord.payload)));
      } catch (error) {
        deps.logger.warn?.(`面板 RPC 失败 endpoint=${endpoint}`, errorDetail(error));
        if (typeof (error as CodedError).code === 'string') {
          return envelopeResponse(rpcId, bad((error as CodedError).code, (error as Error).message));
        }
        // 未分类的内部错误可能带本机路径，只给通用文案。
        return envelopeResponse(rpcId, bad('internal', '面板操作失败'));
      }
    };

    const register = (link: ConnectionLike | undefined): (() => void) | undefined => {
      const face = link?.fetch;
      if (face === undefined || typeof face.register !== 'function') {
        deps.logger.warn?.('面板 RPC 未注册：宿主未提供 connection.fetch');
        return undefined;
      }
      const state = panelRoute();

      if (state.handler !== null) {
        // 同路径路由已在（HMR 重叠）：接管处理函数，路由归创建它的实例。
        state.handler = dispatch;
        return () => {
          if (state.handler === dispatch) state.handler = null;
        };
      }

      let ownOff: (() => void) | null = null;
      try {
        const dispose = face.register({
          path: RPC_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: (request: Request) =>
            state.handler === null ? Promise.resolve(new Response('插件未运行', { status: 503 })) : state.handler(request),
        });
        ownOff = typeof dispose === 'function' ? dispose : null;
      } catch (error) {
        // 进程里已有本插件注册的同路径路由（旧实例还没卸完）：接管 handler，不再注册。
        deps.logger.warn?.('面板 RPC 路由已存在，改为接管现有路由', errorDetail(error));
      }

      state.handler = dispatch;
      state.off = ownOff;
      return () => {
        // 已被后继实例接管时不动路由，摘除交给最后卸下的那个。
        if (state.handler !== dispatch) return;
        state.handler = null;
        const release = state.off;
        state.off = null;
        if (release !== null) release();
      };
    };

    if (typeof scope.effect === 'function') {
      scope.effect(() => {
        const dispose = register(connection);
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      }, 'dsh-im-lark: 面板 RPC');
    } else {
      register(connection);
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
