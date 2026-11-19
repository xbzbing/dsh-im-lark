/**
 * 入站去重：飞书重推事件是常态，同一 `message_id` 必须只处理一次。
 *
 * 用**内存表 + TTL**，不落盘：
 * - 重推窗口远小于进程生命周期，落盘收益低；
 * - 进程重启后从头收一遍，比漏处理安全（多回一遍 vs 用户干等）。
 *
 * 键由调用方拼（入站用 `chat_id + message_id`），这里只负责「见过没有」。
 */

export interface SeenStoreOptions {
  /** 条目存活时间；默认 1 小时（远大于重推窗口）。 */
  ttlMs?: number;
  /** 表容量上限，超了先删最旧的；默认 5000。 */
  max?: number;
  /** 取时间，测试可注入。 */
  now?: () => number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX = 5000;

export class SeenStore {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  /** 插入顺序即时间顺序，Map 迭代顺序可用来淘汰。 */
  readonly #seen = new Map<string, number>();

  constructor(options: SeenStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#max = options.max ?? DEFAULT_MAX;
    this.#now = options.now ?? Date.now;
  }

  /** 第一次见到返回 `true`；重复或已过期后再次出现也算第一次。 */
  claim(key: string): boolean {
    const now = this.#now();
    this.#prune(now);

    const previous = this.#seen.get(key);
    if (previous !== undefined && now - previous < this.#ttlMs) return false;

    this.#seen.set(key, now);
    if (this.#seen.size > this.#max) {
      // Map 保序：删最早插入的那一条。
      const oldest = this.#seen.keys().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }
    return true;
  }

  /** 处理失败时撤回认领，让平台重推的消息还能再试一次。 */
  release(key: string): void {
    this.#seen.delete(key);
  }

  /** 只查不写；用于调试与面板展示。 */
  has(key: string): boolean {
    const previous = this.#seen.get(key);
    if (previous === undefined) return false;
    return this.#now() - previous < this.#ttlMs;
  }

  get size(): number {
    return this.#seen.size;
  }

  #prune(now: number): void {
    for (const [key, stamp] of this.#seen) {
      if (now - stamp < this.#ttlMs) break; // 插入有序，后面的都还新鲜。
      this.#seen.delete(key);
    }
  }
}
