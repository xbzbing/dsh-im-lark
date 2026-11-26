/**
 * 独立模式的状态：绑定会话与主人身份。
 *
 * 两份都要跨重启保留：
 * - `direct.json`：第一次发消息建出来的会话 id，之后一直复用它（否则每次重启都
 *   开新会话，历史散成一地）；
 * - `owner.json`：谁是这个机器人的主人。第一次在**单聊**里说话的人被认作主人，
 *   之后其他人的消息一律不处理（没有配对流程时的最小安全边界）。
 *
 * 都按私密文件写（目录 0700、文件 0600、临时文件 + rename）。
 */

import { join } from 'node:path';

import { readJsonIfPresent, writePrivateFile } from './files.ts';
import type { StateLogger } from './files.ts';

export interface DirectBinding {
  sessionId: string;
  workspaceId: string;
  title?: string;
  /** 由 `/switch` 切过来：回复前标出会话名，重启后仍然生效。 */
  switched?: boolean;
  /** 最初绑定的前台会话；`/switch` 只改当前绑定，不动它。 */
  frontSessionId?: string;
  /** 前台会话的标题；切走之后仍然记得，回到前台时用它。 */
  frontTitle?: string;
}

export interface FrontSession {
  sessionId: string;
  title: string;
}

/**
 * 取出前台会话。
 *
 * 旧版 `direct.json` 没有 `frontSessionId`：只要不是 `/switch` 过来的，就把当前绑定
 * 当作前台；已经切走又没记前台时返回 null，只能靠 `/new` 重新建一个。
 */
export function frontSessionOf(binding: DirectBinding | null): FrontSession | null {
  if (binding === null) return null;
  const sessionId = binding.frontSessionId ?? (binding.switched === true ? '' : binding.sessionId);
  if (sessionId === '') return null;
  const title = sessionId === binding.sessionId ? binding.frontTitle ?? binding.title ?? '' : binding.frontTitle ?? '';
  return { sessionId, title };
}

export interface OwnerIdentity {
  openId: string;
  /** 主人最近一次说话的单聊 id；主动发消息（CLI）用它。 */
  chatId: string;
}

const DIRECT_FILE = 'direct.json';
const OWNER_FILE = 'owner.json';

export class DirectBindingStore {
  readonly #path: string;
  readonly #logger: StateLogger;
  #binding: DirectBinding | null | undefined;
  /** 首次读盘的 single-flight：并发 get 不会各读一份、互相覆盖。 */
  #loading: Promise<DirectBinding | null> | null = null;
  /** 串行读改写：标题事件与 `/switch` 交错时，后执行的变更总能读到前一次的结果。 */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; logger?: StateLogger }) {
    this.#path = join(options.dataDir, DIRECT_FILE);
    this.#logger = options.logger ?? {};
  }

  async get(): Promise<DirectBinding | null> {
    if (this.#binding !== undefined) return this.#binding;
    if (this.#loading !== null) return this.#loading;
    this.#loading = readJsonIfPresent(this.#path, this.#logger)
      .then((raw) => {
        this.#binding = normalizeBinding(raw);
        return this.#binding;
      })
      .finally(() => {
        this.#loading = null;
      });
    return this.#loading;
  }

  /** 同步视图（事件回调里不想 await）；未 load 前恒为 null。 */
  peek(): DirectBinding | null {
    return this.#binding ?? null;
  }

  async set(binding: DirectBinding): Promise<void> {
    await this.update(() => binding);
  }

  /** 更新标题；给了 `sessionId` 时只改仍指向它的当前绑定或前台会话。 */
  async setTitle(title: string, sessionId?: string): Promise<void> {
    await this.update((current) => {
      if (current === null) return undefined;
      const target = sessionId ?? current.sessionId;
      const next: DirectBinding = { ...current };
      let changed = false;
      if (current.sessionId === target && current.title !== title) {
        next.title = title;
        changed = true;
      }
      if (current.frontSessionId === target && current.frontTitle !== title) {
        next.frontTitle = title;
        changed = true;
      }
      return changed ? next : undefined;
    });
  }

  async clear(): Promise<void> {
    await this.update(() => null);
  }

  /**
   * 排队做一次读改写。mutator 返回 undefined 表示不变，null 表示清空。
   * 所有状态变更都走这里，避免命令拿着旧快照覆盖期间到达的标题事件。
   */
  async update(mutator: (current: DirectBinding | null) => DirectBinding | null | undefined): Promise<void> {
    const run = this.#queue.then(async () => {
      const current = await this.get();
      const next = mutator(current);
      if (next === undefined) return;
      if (next === null && current === null) return;
      this.#binding = next;
      const text = `${JSON.stringify(next, null, 2)}\n`;
      await writePrivateFile(this.#path, text);
    });
    this.#queue = run.catch(() => undefined);
    await run;
  }

  /** 等排队中的写入落盘（测试与停机用）。 */
  async drain(): Promise<void> {
    await this.#queue;
  }
}

function normalizeBinding(raw: unknown): DirectBinding | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  if (sessionId === '') return null;

  const switched = record.switched === true;
  const title = typeof record.title === 'string' ? record.title : '';
  const storedFrontId = typeof record.frontSessionId === 'string' ? record.frontSessionId : '';
  // 旧版没有前台字段：未切换过的绑定就是前台，切换过的不知道前台是谁。
  const frontSessionId = storedFrontId !== '' ? storedFrontId : switched ? '' : sessionId;
  const storedFrontTitle = typeof record.frontTitle === 'string' ? record.frontTitle : '';
  const frontTitle = storedFrontTitle !== '' ? storedFrontTitle : frontSessionId === sessionId ? title : '';

  return {
    sessionId,
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : '',
    ...(title !== '' ? { title } : {}),
    ...(switched ? { switched: true } : {}),
    ...(frontSessionId !== '' ? { frontSessionId } : {}),
    ...(frontTitle !== '' ? { frontTitle } : {}),
  };
}

export class OwnerStore {
  readonly #path: string;
  readonly #logger: StateLogger;
  #owner: OwnerIdentity | null | undefined;

  constructor(options: { dataDir: string; logger?: StateLogger }) {
    this.#path = join(options.dataDir, OWNER_FILE);
    this.#logger = options.logger ?? {};
  }

  async get(): Promise<OwnerIdentity | null> {
    if (this.#owner !== undefined) return this.#owner;
    const raw = await readJsonIfPresent(this.#path, this.#logger);
    this.#owner = normalizeOwner(raw);
    return this.#owner;
  }

  peek(): OwnerIdentity | null {
    return this.#owner ?? null;
  }

  /** 第一次见到主人时落盘；已经有人认领则不动。返回最终的主人。 */
  async claim(openId: string, chatId: string): Promise<OwnerIdentity> {
    const existing = await this.get();
    if (existing !== null) return existing;
    const owner: OwnerIdentity = { openId, chatId };
    this.#owner = owner;
    await writePrivateFile(this.#path, `${JSON.stringify(owner, null, 2)}\n`);
    return owner;
  }

  /**
   * 核心模式下镜像核心的绑定结果：核心说「这是主人」时才调用。
   * 独立模式自己认主人，两边不会同时写。
   */
  async remember(openId: string, chatId: string): Promise<void> {
    const current = await this.get();
    if (current === null) {
      const owner: OwnerIdentity = { openId, chatId };
      this.#owner = owner;
      await writePrivateFile(this.#path, `${JSON.stringify(owner, null, 2)}\n`);
      return;
    }
    if (current.openId === openId && current.chatId !== chatId) await this.rememberChat(chatId);
  }

  /** 记录主人最近活跃的单聊，主动发送用。 */
  async rememberChat(chatId: string): Promise<void> {
    const current = await this.get();
    if (current === null || current.chatId === chatId) return;
    const next: OwnerIdentity = { ...current, chatId };
    this.#owner = next;
    await writePrivateFile(this.#path, `${JSON.stringify(next, null, 2)}\n`);
  }

  async isOwner(openId: string): Promise<boolean> {
    const owner = await this.get();
    return owner !== null && owner.openId === openId;
  }

  async clear(): Promise<void> {
    this.#owner = null;
    await writePrivateFile(this.#path, `${JSON.stringify(null)}\n`);
  }
}

function normalizeOwner(raw: unknown): OwnerIdentity | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const openId = typeof record.openId === 'string' ? record.openId : '';
  if (openId === '') return null;
  return { openId, chatId: typeof record.chatId === 'string' ? record.chatId : '' };
}
