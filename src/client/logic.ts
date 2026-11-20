/**
 * 面板的纯逻辑：RPC 调用、信封拆解、错误文案、契约检查。
 *
 * 不依赖 React，单测可以直接覆盖：宿主没连上、契约版本不一致、后端返回
 * `invalid-config` 时该显示什么，都在这里定，组件只负责渲染。
 */

import { PANEL_CONTRACT, RPC_ENDPOINT, RPC_PREFIX, RPC_TIMEOUT_MS } from './constants.ts';
import type { Translate } from './locales.ts';

export interface CodedError extends Error {
  code?: string;
}

/** 拆宿主的 RPC 结果：新宿主是 `{ok, value}`，旧宿主多一层 `result`。 */
export function unwrapResult(raw: unknown): unknown {
  const envelope = isRecord(raw) ? raw : {};
  const result = isRecord(envelope.result) ? envelope.result : envelope;
  if (typeof result.ok !== 'boolean') {
    throw codedError('invalid-response', '宿主返回了无法识别的响应');
  }
  if (result.ok === false) {
    const error = isRecord(result.error) ? result.error : {};
    throw codedError(
      typeof error.code === 'string' ? error.code : 'rpc-failed',
      typeof error.message === 'string' && error.message !== '' ? error.message : '',
    );
  }
  return result.value;
}

/** 造面板用的 RPC 调用。 */
export function createRpcCall(connection: unknown) {
  return async function rpcCall<T = unknown>(endpoint: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> {
    const rpc = (connection as { rpc?: { call?: (...args: unknown[]) => Promise<unknown> } } | null | undefined)?.rpc;
    if (rpc === undefined || typeof rpc.call !== 'function') {
      throw codedError('connection-unavailable', '当前页面没有可用的 Host 连接');
    }
    // channel/endpoint 会拼成 POST `<channel>/<endpoint>`：和 host 的 exact 路由一致。
    const raw = await rpc.call(
      RPC_PREFIX,
      RPC_ENDPOINT,
      { method: endpoint, payload },
      signal ?? AbortSignal.timeout(RPC_TIMEOUT_MS),
    );
    return unwrapResult(raw) as T;
  };
}

export function codedError(code: string, message: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 宿主给了原文就显示原文；连接类错误换成可操作的提示。 */
export function errorText(t: Translate, error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message !== '') return message;
  const code = (error as CodedError | null)?.code;
  if (code === 'connection-unavailable') return t('error.connection');
  return t('error.generic');
}

/** 契约版本不一致时页面只显示重启提示。 */
export function isContractMismatch(snapshot: unknown): boolean {
  return isRecord(snapshot) && typeof snapshot.contract === 'number' && snapshot.contract !== PANEL_CONTRACT;
}

export function isHostOlder(snapshot: unknown): boolean {
  return isRecord(snapshot) && typeof snapshot.contract === 'number' && snapshot.contract < PANEL_CONTRACT;
}

/** 状态点颜色：与宿主的 StateDot 语义对齐。 */
export function dotOf(state: string): 'done' | 'ongoing' | 'warning' | 'error' | 'idle' {
  switch (state) {
    case 'connected':
      return 'done';
    case 'connecting':
    case 'reconnecting':
      return 'ongoing';
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
}
