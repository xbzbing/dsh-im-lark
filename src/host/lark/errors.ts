/**
 * 飞书错误分类。
 *
 * 平台把失败原因藏在三个地方：HTTP 状态码、响应体 `code`、以及个别接口的
 * 子错误码。分类只做一件事——决定**下一步怎么办**（退避重试 / 停止重试 / 降级 /
 * 报给人看），不做文案渲染。文案在面板层拼。
 *
 * 错误码取值见 `docs/protocol/00-飞书开放平台事实.md` §6。
 */

export type LarkFailureKind =
  /** 触发频控（429 / 99991400 / 230020）：按平台给的等待时间退避。 */
  | 'rate-limited'
  /** 凭据无效或过期（99991661 / 99991663 / 99991668 等）：需要重新配置。 */
  | 'auth'
  /** 内容超长（230025）：应改用分条。 */
  | 'too-long'
  /** 机器人不在群 / 无发言权限（230002 / 230018 / 230035）：不是重试能解决的。 */
  | 'forbidden'
  /** 接收者非法或不在可用范围（230013 / 230034 / 230053）：同上。 */
  | 'recipient'
  /** 消息已被撤回 / 不存在（230011 / 230110）：调用方要放弃这次操作。 */
  | 'gone'
  /** 网络或超时：可重试。 */
  | 'network'
  /** 其它：按失败处理，重试一次后放弃。 */
  | 'other';

export interface LarkFailureInit {
  kind: LarkFailureKind;
  /** 平台错误码（若有）。 */
  code?: number;
  /** 平台原始消息（英文原文，只进日志，不进用户交付）。 */
  message?: string;
  /** 建议等待毫秒数（频控时来自 `x-ogw-ratelimit-reset` 或次数推导）。 */
  retryAfterMs?: number;
  /** HTTP 状态码（若有）。 */
  status?: number;
}

export class LarkFailure extends Error {
  readonly kind: LarkFailureKind;
  readonly code: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;

  constructor(init: LarkFailureInit) {
    super(init.message ?? init.kind);
    this.name = 'LarkFailure';
    this.kind = init.kind;
    this.code = init.code;
    this.retryAfterMs = init.retryAfterMs;
    this.status = init.status;
  }

  /** 重试是否有意义：频控与网络值得重试，其余重试只是把同一个错误再犯一次。 */
  get retriable(): boolean {
    return this.kind === 'rate-limited' || this.kind === 'network' || this.kind === 'other';
  }
}

/** 频控错误码。 */
const RATE_LIMIT_CODES = new Set([99991400, 230020, 11232]);
/** token 类错误码：需要重新配置或重新取 token。 */
const AUTH_CODES = new Set([99991661, 99991663, 99991664, 99991668, 99991671, 99991672, 20005]);
/** 机器人与目标关系不对：重试无用。 */
const FORBIDDEN_CODES = new Set([230002, 230006, 230018, 230027, 230035, 230075]);
/** 接收者问题。 */
const RECIPIENT_CODES = new Set([230013, 230034, 230038, 230053]);
/** 目标已不存在或已撤回。 */
const GONE_CODES = new Set([230011, 230019, 230110, 232009]);

function kindOfCode(code: number): LarkFailureKind | undefined {
  if (RATE_LIMIT_CODES.has(code)) return 'rate-limited';
  if (AUTH_CODES.has(code)) return 'auth';
  if (code === 230025) return 'too-long';
  if (FORBIDDEN_CODES.has(code)) return 'forbidden';
  if (RECIPIENT_CODES.has(code)) return 'recipient';
  if (GONE_CODES.has(code)) return 'gone';
  return undefined;
}

/** 平台业务码 → 已分类的失败；SDK 不 reject 业务错误，识别后必须按码定性。 */
export function failureOfCode(code: number, message = '平台返回错误'): LarkFailure {
  return new LarkFailure({ kind: kindOfCode(code) ?? 'other', code, message });
}

/** 从任意抛出物里抠出 HTTP 状态与平台错误码（axios / SDK / 自造错误都可能）。 */
function probe(error: unknown): { status?: number; code?: number; message?: string; retryAfterMs?: number } {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  let status: number | undefined;
  let code: number | undefined;
  let message: string | undefined;
  let retryAfterMs: number | undefined;

  while (queue.length > 0) {
    const value = queue.shift();
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      if (seen.has(value)) continue;
      seen.add(value);
    }

    if (typeof value === 'string' && message === undefined) {
      message = value;
      continue;
    }
    if (typeof value !== 'object') continue;

    const record = value as Record<string, unknown>;
    if (status === undefined && typeof record.status === 'number') status = record.status;
    if (code === undefined && typeof record.code === 'number') code = record.code;
    if (message === undefined && typeof record.message === 'string' && record.message !== '') {
      message = record.message;
    }

    const response = record.response as Record<string, unknown> | undefined;
    if (response && typeof response === 'object') {
      if (status === undefined && typeof response.status === 'number') status = response.status;
      const headers = response.headers as Record<string, unknown> | undefined;
      if (headers && typeof headers === 'object') {
        const reset = headers['x-ogw-ratelimit-reset'];
        if (retryAfterMs === undefined && reset !== undefined) {
          const seconds = Number(reset);
          if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = seconds * 1000;
        }
      }
      queue.push(response.data);
    }

    const body = record.data as Record<string, unknown> | undefined;
    if (body && typeof body === 'object') queue.push(body);
    if (record.error !== undefined) queue.push(record.error);
    if (record.cause !== undefined) queue.push(record.cause);
  }

  return { status, code, message, retryAfterMs };
}

/** 把任意抛出物收敛成 `LarkFailure`。 */
export function toLarkFailure(error: unknown): LarkFailure {
  if (error instanceof LarkFailure) return error;

  const { status, code, message, retryAfterMs } = probe(error);

  let kind: LarkFailureKind | undefined;
  if (code !== undefined) kind = kindOfCode(code);
  if (kind === undefined && status === 429) kind = 'rate-limited';
  if (kind === undefined && status === 401) kind = 'auth';
  if (kind === undefined) {
    const text = (message ?? '').toLowerCase();
    if (text.includes('timeout') || text.includes('econnreset') || text.includes('enotfound') || text.includes('socket hang up')) {
      kind = 'network';
    } else if (status !== undefined && status >= 500) {
      kind = 'network';
    }
  }

  return new LarkFailure({
    kind: kind ?? 'other',
    code,
    message,
    retryAfterMs,
    status,
  });
}

/**
 * 频控退避时间：平台给了就按平台说的来，没给就按尝试次数指数退避（1s、2s、4s…）。
 * 上限 30 秒——再久就不如把交付回执成 `failed` 让核心另想办法。
 */
export function retryDelayMs(failure: LarkFailure, attempt: number): number {
  if (failure.retryAfterMs !== undefined) return Math.min(failure.retryAfterMs + 250, 30_000);
  const base = 1_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 30_000);
}
