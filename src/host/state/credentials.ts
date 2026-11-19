/**
 * 凭据存储与自检。
 *
 * 凭据只落本机状态文件（`0700` 目录、`0600` 文件、原子写），**不进日志、不进面板
 * 快照、不随包发布**。面板能看到的只有 App ID 与尾号。
 *
 * 自检走两条独立的最小请求：先换 `tenant_access_token`（验 app_id/app_secret），
 * 再查机器人信息（验机器人能力是否开启）。两件事分开报错，面板才能给出
 * 「密钥不对」和「机器人能力没开」两种不同的提示。
 */

import { join } from 'node:path';

import type { LarkLogger } from '../lark/connection.ts';
import type { LarkCredentialCheck, LarkCredentials, LarkCredentialSummary, LarkDomain } from '../lark/types.ts';
import { baseUrlOf } from '../lark/api.ts';
import { readJsonIfPresent, writePrivateFile } from './files.ts';

/** 凭据文件名。 */
const CREDENTIALS_FILE = 'credentials.json';

/** App ID 尾号长度：面板只显示这么多，够区分不同应用就够了。 */
const TAIL_LENGTH = 6;

export interface CredentialStoreOptions {
  dataDir: string;
  logger?: LarkLogger;
}

/** 面板能看到的凭据摘要。 */
export function summarize(appId: string, domain: LarkDomain): LarkCredentialSummary {
  const tail = appId.length > TAIL_LENGTH ? appId.slice(-TAIL_LENGTH) : appId;
  return { appId, appIdTail: tail, domain };
}

/** 收窄磁盘上的凭据：形状不对就当没配置。 */
function normalizeStored(raw: unknown): LarkCredentials | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  const appId = typeof input.appId === 'string' ? input.appId.trim() : '';
  const appSecret = typeof input.appSecret === 'string' ? input.appSecret.trim() : '';
  const domain = input.domain === 'lark' ? 'lark' : 'feishu';
  if (appId === '' || appSecret === '') return undefined;
  return { appId, appSecret, domain };
}

export class CredentialStore {
  readonly #path: string;
  readonly #logger: LarkLogger;
  #cached: LarkCredentials | null | undefined;

  constructor(options: CredentialStoreOptions) {
    this.#path = join(options.dataDir, CREDENTIALS_FILE);
    this.#logger = options.logger ?? {};
  }

  /** 读凭据；没有或损坏返回 null。 */
  async load(): Promise<LarkCredentials | null> {
    if (this.#cached !== undefined) return this.#cached;
    const raw = await readJsonIfPresent(this.#path, this.#logger);
    const parsed = normalizeStored(raw);
    if (raw !== undefined && parsed === undefined) {
      this.#logger.warn?.('凭据文件存在但内容不完整，按未配置处理');
    }
    this.#cached = parsed ?? null;
    return this.#cached;
  }

  /** 覆盖保存；返回可以展示的摘要。 */
  async save(input: { appId: string; appSecret: string; domain: LarkDomain }): Promise<LarkCredentialSummary> {
    const appId = input.appId.trim();
    const appSecret = input.appSecret.trim();
    if (appId === '') throw new Error('App ID 不能为空');
    if (appSecret === '') throw new Error('App Secret 不能为空');
    const payload: LarkCredentials = { appId, appSecret, domain: input.domain };
    await writePrivateFile(this.#path, `${JSON.stringify(payload, null, 2)}\n`);
    this.#cached = payload;
    return summarize(appId, input.domain);
  }

  /** 清空凭据（卸载应用或换应用时用）。 */
  async clear(): Promise<void> {
    await writePrivateFile(this.#path, `${JSON.stringify({}, null, 2)}\n`);
    this.#cached = null;
  }

  /** 已配置时的摘要；未配置返回 null。 */
  async summary(): Promise<LarkCredentialSummary | null> {
    const app = await this.load();
    return app ? summarize(app.appId, app.domain) : null;
  }
}

/** 平台响应的最小形状。 */
interface TokenResponse {
  code?: number;
  msg?: string;
  access_token?: string;
  tenant_access_token?: string;
  expire?: number;
  expires_in?: number;
}

interface BotInfoResponse {
  code?: number;
  msg?: string;
  bot?: {
    open_id?: string;
    app_name?: string;
  };
}

export interface ProbeOptions {
  app: LarkCredentials;
  fetch?: typeof globalThis.fetch;
  /** 单次请求超时（毫秒），默认 10 秒。 */
  timeoutMs?: number;
}

/**
 * 凭据自检。
 *
 * 不抛错：面板要的是「能用/不能用 + 原因」，异常留给调用方反而是负担。
 */
export async function probeCredentials(options: ProbeOptions): Promise<LarkCredentialCheck> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = baseUrlOf(options.app.domain);
  const timeoutMs = options.timeoutMs ?? 10_000;

  let token: string;
  try {
    const response = await doFetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: options.app.appId, app_secret: options.app.appSecret }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, error: `换取访问凭证失败：HTTP ${response.status}` };
    }
    const body = (await response.json()) as TokenResponse;
    if (typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: describeTokenError(body.code, body.msg) };
    }
    // 新版返回 `access_token`（JWT），旧版是 `tenant_access_token`；两种都认。
    const value = body.access_token ?? body.tenant_access_token;
    if (typeof value !== 'string' || value === '') {
      return { ok: false, error: '换取访问凭证失败：响应里没有凭证' };
    }
    token = value;
  } catch (error) {
    return { ok: false, error: `换取访问凭证失败：${(error as Error).message}` };
  }

  try {
    const response = await doFetch(`${base}/open-apis/bot/v3/info`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json()) as BotInfoResponse;
    if (typeof body.code === 'number' && body.code !== 0) {
      return { ok: false, error: describeBotError(body.code, body.msg) };
    }
    return {
      ok: true,
      ...(body.bot?.open_id ? { botOpenId: body.bot.open_id } : {}),
      ...(body.bot?.app_name ? { botName: body.bot.app_name } : {}),
    };
  } catch (error) {
    // 凭证已经换到了，说明密钥没问题；机器人信息查不到多半是能力没开，按可读原因返回。
    return { ok: false, error: `读取机器人信息失败：${(error as Error).message}` };
  }
}

function describeTokenError(code: number, message?: string): string {
  switch (code) {
    case 10003:
    case 10014:
      return 'App ID 或 App Secret 不正确';
    case 10012:
    case 10013:
      return '应用不存在或已被停用';
    case 99991661:
    case 99991663:
      return '访问凭证无效';
    default:
      return `换取访问凭证失败：${message ?? `错误码 ${code}`}`;
  }
}

function describeBotError(code: number, message?: string): string {
  switch (code) {
    case 230006:
      return '应用未开启机器人能力（开发者后台 → 应用能力 → 添加「机器人」）';
    case 230027:
      return '应用缺少所需权限（检查 im:message 与 im:resource）';
    case 10010:
      return '机器人能力未生效：修改权限或能力后需要创建并发布版本';
    default:
      return `读取机器人信息失败：${message ?? `错误码 ${code}`}`;
  }
}
