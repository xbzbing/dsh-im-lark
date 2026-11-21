/**
 * 提问与授权共用的机械件：延迟结算、abort 监听、取消原因、待答表。
 *
 * 两个 broker 的骨架一样（等 Web 先答 → 到点发提醒 → 与 Web 竞速 → 超时交回），
 * 差别只在结局映射与词表。这里只放与语义无关的部分，收尾方式仍由各自决定：
 * 提问要 abort 本地信号让 Web 卡片收起，授权只要把请求交回 Web。
 */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** 一个信号 abort 时 resolve（不 reject，便于直接参与 race）。 */
export function whenAborted(signal: AbortSignal | undefined): { promise: Promise<void>; dispose(): void } {
  let dispose = (): void => {};
  const promise = new Promise<void>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, dispose };
}

/** 带 name/code 的取消原因：宿主按 code 区分「用户取消」与别的失败。 */
export function abortReason(message: string, code = 'ASK_ABORTED'): Error {
  const error = new Error(message);
  error.name = 'UserQuestionError';
  (error as { code?: string }).code = code;
  return error;
}

export interface PendingEntry {
  readonly id: string;
}

/**
 * 待答表：插入顺序就是新旧顺序，上限在插入之后收口。
 *
 * `sweep()` 返回被挤掉的条目而不是自己结算——提问要 abort，授权要交回，表本身
 * 不该知道这两种收尾的差别。
 */
export class PendingTable<T extends PendingEntry> {
  readonly #max: number;
  readonly #entries = new Map<string, T>();

  constructor(max: number) {
    this.#max = max;
  }

  get size(): number {
    return this.#entries.size;
  }

  add(entry: T): void {
    this.#entries.set(entry.id, entry);
  }

  delete(id: string): void {
    this.#entries.delete(id);
  }

  clear(): void {
    this.#entries.clear();
  }

  values(): IterableIterator<T> {
    return this.#entries.values();
  }

  /** 最新的一条（主人看到的是最近发出的提醒）。 */
  newest(): T | undefined {
    let last: T | undefined;
    for (const entry of this.#entries.values()) last = entry;
    return last;
  }

  /** 新→旧：认领时先试最近的一条。 */
  newestFirst(): T[] {
    return [...this.#entries.values()].reverse();
  }

  /** 超出上限时挤掉最旧的，返回被挤掉的条目（最旧在前）。 */
  sweep(): T[] {
    const dropped: T[] = [];
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      const entry = this.#entries.get(oldest.value);
      this.#entries.delete(oldest.value);
      if (entry !== undefined) dropped.push(entry);
    }
    return dropped;
  }
}
