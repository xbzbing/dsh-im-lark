/**
 * 宿主上下文的最小结构描述。
 *
 * 不 import 宿主包：插件按 Cordis 的公开形状使用服务，宿主版本变化时不会因为
 * 类型包对不上而装不上（工程约定见 AGENTS.md）。这里只声明本插件真正用到的字段。
 */

export interface PluginLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
  error?(...args: unknown[]): unknown;
  debug?(...args: unknown[]): unknown;
}

/** `ctx.logger`：本插件按 `ctx.logger(name)` 或 `ctx.logger` 直接取。 */
export type LoggerLike = PluginLogger | ((name: string) => PluginLogger);

/** RPC 失败信封：code 给页面判分支，message 是给人看的文案。 */
export interface RpcFailure {
  code: string;
  message: string;
  details: object;
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcFailure };

/** 面板 RPC 的一次调用：端点名 + 已解码的 payload。 */
export type RpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: unknown,
) => Promise<RpcResult<unknown>>;

/** 宿主 `connection` 服务里本插件用到的部分：注册一条逻辑 RPC 通道。 */
export interface ConnectionLike {
  rpc: {
    handle(channel: string, handler: RpcHandler): () => Promise<void>;
  };
}

export interface PluginContext {
  logger?: LoggerLike;
  effect?(execute: () => () => void, label?: string): unknown;
  inject?(services: string[], install: (scope: PluginContext) => void): unknown;
  on?(event: string, listener: (...args: unknown[]) => void, options?: { prepend?: boolean; global?: boolean }): () => void;
  connection?: ConnectionLike;
  [key: string]: unknown;
}

/** 从任意 logger 形状里取一个可用的 logger。 */
export function resolveLogger(value: unknown, name = 'dsh-im-lark'): PluginLogger {
  if (typeof value === 'function') {
    try {
      const scoped = (value as (name: string) => unknown)(name);
      if (scoped && typeof scoped === 'object') return scoped as PluginLogger;
    } catch {
      // 宿主 logger 工厂抛错时退回空 logger：日志不该阻断插件加载。
    }
    return {};
  }
  if (value && typeof value === 'object') return value as PluginLogger;
  return {};
}

/** 取错误的可读描述；只用于日志与面板文案，不参与判定。 */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 可选注入：服务在就用，不在就跳过。
 *
 * 不用顶层 `inject`：缺某个服务的组合里插件仍应照常加载，只是对应能力不可用。
 */
export function injectOptional(
  ctx: PluginContext,
  service: string,
  install: (scope: PluginContext) => void,
): void {
  if (typeof ctx.inject !== 'function') return;
  try {
    ctx.inject([service], install);
  } catch {
    // 宿主不支持可选注入时静默跳过；能力缺失会在面板上显示原因。
  }
}
