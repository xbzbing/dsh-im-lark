/**
 * `/sessions` 的序号快照：最近一次列出的会话顺序。
 *
 * 序号只在主人重新发 `/sessions` 时换一份，所以要落盘——插件重启后旧序号仍指向
 * 同一个会话，而不是悄悄换了一个。文件 `sessions.json`，目录 `0700`、文件 `0600`、
 * 原子写（与其它状态一致）。
 */

import { join } from 'node:path';

import { readJsonIfPresent, writePrivateFile } from './files.ts';
import type { StateLogger } from './files.ts';

/** 一份快照最多记多少个会话：命令只列最近活跃的，超出部分到 Web 端看。 */
export const MAX_LISTING = 100;

export interface ListingEntry {
  sessionId: string;
  title: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 逐条校验快照：坏条目丢掉，不因一个字段把整份作废。 */
export function parseListing(value: unknown): ListingEntry[] {
  const rows = Array.isArray(value) ? value : [];
  const out: ListingEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const entry = asRecord(raw);
    const sessionId = text(entry?.sessionId);
    if (sessionId === '' || seen.has(sessionId) || out.length >= MAX_LISTING) continue;
    seen.add(sessionId);
    out.push({ sessionId, title: text(entry?.title).slice(0, 200) });
  }
  return out;
}

export class ListingStore {
  readonly #path: string;
  readonly #logger: StateLogger;
  #entries: ListingEntry[] | undefined;

  constructor(options: { dataDir: string; logger?: StateLogger }) {
    this.#path = join(options.dataDir, 'sessions.json');
    this.#logger = options.logger ?? {};
  }

  async get(): Promise<readonly ListingEntry[]> {
    if (this.#entries !== undefined) return this.#entries;
    try {
      const raw = await readJsonIfPresent(this.#path, this.#logger);
      this.#entries = parseListing(asRecord(raw)?.listing);
    } catch (error) {
      // 读不出来就当没列过：下一次 /sessions 会重新落一份，不阻断命令。
      this.#logger.warn?.('会话序号快照读取失败', error instanceof Error ? error.message : String(error));
      this.#entries = [];
    }
    return this.#entries;
  }

  async set(entries: readonly ListingEntry[]): Promise<void> {
    this.#entries = parseListing(entries);
    try {
      await writePrivateFile(this.#path, `${JSON.stringify({ version: 1, listing: this.#entries }, null, 2)}\n`);
    } catch (error) {
      // 落盘失败只影响重启后的序号，当前进程里照常可用。
      this.#logger.warn?.('会话序号快照落盘失败', error instanceof Error ? error.message : String(error));
    }
  }
}
