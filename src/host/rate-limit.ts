/**
 * 出站限速：飞书对**同一用户 / 同一群**的发送是 5 QPS（业务侧，非仅 API 侧）。
 *
 * 用滑动窗口而不是固定窗口：固定窗口在边界上会瞬时放出 2 倍配额，撞 429 之后
 * 再退避反而更慢。窗口内满了就等最早那条滑出去，不做「丢弃」——IM 场景里丢一条
 * 就是用户永远看不到。
 */

export interface RateGateOptions {
  /** 窗口内允许的次数，默认 5。 */
  max?: number;
  /** 窗口长度（毫秒），默认 1000。 */
  windowMs?: number;
  now?: () => number;
  /** 等待实现，测试可注入。 */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_SEND_MAX = 5;
export const DEFAULT_SEND_WINDOW_MS = 1000;

export class RateGate {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** 已放行的时间戳，按时间升序。 */
  readonly #stamps: number[] = [];
  /** 串行化：并发调用排队，不会一起看到「还有空位」。 */
  #tail: Promise<void> = Promise.resolve();

  constructor(options: RateGateOptions = {}) {
    this.#max = Math.max(1, options.max ?? DEFAULT_SEND_MAX);
    this.#windowMs = Math.max(1, options.windowMs ?? DEFAULT_SEND_WINDOW_MS);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** 等到有配额再返回。 */
  acquire(): Promise<void> {
    const run = this.#tail.then(() => this.#waitForSlot());
    // 上一个失败也不能卡死队列。
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.#now();
      while (this.#stamps.length > 0 && now - this.#stamps[0]! >= this.#windowMs) this.#stamps.shift();

      if (this.#stamps.length < this.#max) {
        this.#stamps.push(now);
        return;
      }

      const waitMs = this.#windowMs - (now - this.#stamps[0]!);
      await this.#sleep(Math.max(1, waitMs));
    }
  }

  /** 当前窗口内已用配额，面板与测试用。 */
  get used(): number {
    const now = this.#now();
    return this.#stamps.filter((stamp) => now - stamp < this.#windowMs).length;
  }
}
