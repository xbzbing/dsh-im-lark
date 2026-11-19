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

/** 面板 RPC 挂载的路由形状（宿主 webServer 的公开子集）。 */
export interface PanelRoute {
  method: 'POST' | 'GET';
  path: string;
  handler(request: Request): Response | Promise<Response>;
}

export interface WebServerLike {
  route(route: PanelRoute): () => void;
}

export interface PluginContext {
  logger?: LoggerLike;
  effect?(execute: () => () => void, label?: string): unknown;
  inject?(services: string[], install: (scope: PluginContext) => void): unknown;
  on?(event: string, listener: (...args: unknown[]) => void): () => void;
  webServer?: WebServerLike;
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
