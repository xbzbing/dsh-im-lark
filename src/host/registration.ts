/**
 * 一键创建应用（扫码授权）的状态机。
 *
 * SDK 的 `registerApp` 是「先拿验证链接、再在后台轮询授权结果」的长流程；面板需要
 * 「立刻拿到链接、之后轮询结果」，所以拆成 `start` / `poll` / `cancel` 三段。
 *
 * 凭据只在授权成功后写进 `CredentialStore`，绝不回给页面；页面能看到的只有链接、
 * 过期时间与 App ID 尾号。
 */

import type { PluginLogger } from './host-context.ts';
import type { LarkCredentials, LarkDomain } from './lark/types.ts';
import { encodeQr } from './qr.ts';
import type { QrMatrix } from './qr.ts';

export type RegistrationState = 'idle' | 'waiting' | 'done' | 'error';

export interface RegistrationSnapshot {
  state: RegistrationState;
  /** 授权链接；只有 `waiting` 时有值。 */
  url: string | null;
  /** 链接过期时间（epoch ms）；只有 `waiting` 时有值。 */
  expiresAt: number | null;
  /** 面向用户的失败原因；不包含平台原始错误或本机路径。 */
  error: string | null;
  /** 成功后的 App ID 尾号，供面板立即显示。 */
  appIdTail: string | null;
}

/** `start` 的回执：除快照外带上二维码矩阵，后续轮询不必重复传。 */
export interface RegistrationStartSnapshot extends RegistrationSnapshot {
  /** 授权链接的二维码；链接还没就绪或内容超出容量时为 null。 */
  qr: QrMatrix | null;
}

export interface RegistrationStartInput {
  domain: LarkDomain;
  signal: AbortSignal;
  onUrl(info: { url: string; expireIn: number }): void;
}

export interface RegistrationPorts {
  /** 真正调 SDK 的入口；测试里注入假实现。 */
  start(input: RegistrationStartInput): Promise<{ appId: string; appSecret: string }>;
  save(credentials: LarkCredentials): Promise<void>;
  /** 凭据落盘后让运行期重连；失败只记日志，不回滚已保存的凭据。 */
  reload(): Promise<void>;
  logger: PluginLogger;
  now?(): number;
}

export class AppRegistration {
  readonly #ports: RegistrationPorts;
  #state: RegistrationState = 'idle';
  #url: string | null = null;
  #expiresAt: number | null = null;
  #error: string | null = null;
  #appIdTail: string | null = null;
  #controller: AbortController | null = null;
  #task: Promise<void> | null = null;
  #run = 0;

  constructor(ports: RegistrationPorts) {
    this.#ports = ports;
  }

  /** 生成一条新的授权链接；重复调用会取消上一条。 */
  async start(domain: LarkDomain): Promise<RegistrationStartSnapshot> {
    this.#abortCurrent();
    const run = ++this.#run;
    const controller = new AbortController();
    this.#controller = controller;
    this.#state = 'waiting';
    this.#url = null;
    this.#expiresAt = null;
    this.#error = null;
    this.#appIdTail = null;

    let qr: QrMatrix | null = null;
    let ready!: () => void;
    const urlReady = new Promise<void>((resolve) => {
      ready = resolve;
    });

    this.#task = (async () => {
      try {
        const app = await this.#ports.start({
          domain,
          signal: controller.signal,
          onUrl: (info) => {
            if (run !== this.#run) return;
            this.#url = info.url;
            this.#expiresAt = this.#now() + info.expireIn * 1000;
            // 二维码只是展示层的增强：编码失败（例如链接异常长）不影响授权流程，
            // 面板仍可用链接完成授权。
            try {
              qr = encodeQr(info.url);
            } catch {
              qr = null;
            }
            ready();
          },
        });
        if (run !== this.#run) return;

        await this.#ports.save({ appId: app.appId, appSecret: app.appSecret, domain });
        if (run !== this.#run) return;

        this.#state = 'done';
        this.#appIdTail = tailOf(app.appId);
        this.#url = null;
        this.#expiresAt = null;
        // 重连失败不影响「应用已创建、凭据已保存」这个事实，状态里会带 lastError。
        void this.#ports.reload().catch((error: unknown) => {
          this.#ports.logger.warn?.('创建应用后重连失败', describe(error));
        });
      } catch (error) {
        if (run !== this.#run) return;
        if (controller.signal.aborted) {
          this.#state = 'idle';
          this.#url = null;
          this.#expiresAt = null;
          return;
        }
        this.#state = 'error';
        this.#error = registrationError(error);
        this.#url = null;
        this.#expiresAt = null;
      } finally {
        if (run === this.#run) this.#controller = null;
      }
    })();

    // 链接就绪或任务提前结束（失败）都算一次有效的 start 回执。
    await Promise.race([urlReady, this.#task]);
    return { ...this.snapshot(), qr };
  }

  /** 面板轮询：等待中且已过期时转成 error，不把过期链接继续展示。 */
  poll(): RegistrationSnapshot {
    if (this.#state === 'waiting' && this.#expiresAt !== null && this.#now() >= this.#expiresAt) {
      this.#expire();
    }
    return this.snapshot();
  }

  cancel(): RegistrationSnapshot {
    this.#run += 1;
    this.#abortCurrent();
    this.#state = 'idle';
    this.#url = null;
    this.#expiresAt = null;
    this.#error = null;
    this.#appIdTail = null;
    return this.snapshot();
  }

  snapshot(): RegistrationSnapshot {
    return {
      state: this.#state,
      url: this.#url,
      expiresAt: this.#expiresAt,
      error: this.#error,
      appIdTail: this.#appIdTail,
    };
  }

  #expire(): void {
    if (this.#state !== 'waiting') return;
    this.#run += 1;
    this.#abortCurrent();
    this.#state = 'error';
    this.#error = '二维码已过期，请重新生成';
    this.#url = null;
    this.#expiresAt = null;
  }

  #abortCurrent(): void {
    this.#controller?.abort();
    this.#controller = null;
  }

  #now(): number {
    return this.#ports.now?.() ?? Date.now();
  }
}

function tailOf(appId: string): string {
  return appId.length > 6 ? appId.slice(-6) : appId;
}

/**
 * SDK 的授权错误是普通对象 `{code, description}`（abort 也一样），不是 Error；
 * 这里统一取出可匹配的文本，避免把 `[object Object]` 当错误细节。
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : typeof record.error === 'string' ? record.error : '';
    const description =
      typeof record.description === 'string'
        ? record.description
        : typeof record.error_description === 'string'
          ? record.error_description
          : '';
    const text = [code, description].filter((part) => part !== '').join(' ');
    if (text !== '') return text;
  }
  return String(error);
}

/** 平台错误 → 可展示文案；不把原始 message 透给页面（可能带路径或内部细节）。 */
function registrationError(error: unknown): string {
  const message = describe(error);
  if (/access_denied/iu.test(message)) return '授权被拒绝，请重新生成二维码';
  if (/expired_token|timed out/iu.test(message)) return '二维码已过期，请重新生成';
  if (/network|econn|enotfound|etimedout|timeout/iu.test(message)) return '连接飞书开放平台失败，请检查网络后重试';
  return '创建应用失败，请重试';
}
