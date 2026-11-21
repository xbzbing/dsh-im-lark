/**
 * 工作区：面板的候选列表 + 独立模式的默认工作区。
 *
 * 默认工作区是 `$DSH_HOME/dsh-im-lark` 下的「飞书会话」：这个目录只当会话 cwd，
 * **不是**插件状态目录——状态里有 App Secret，而会话里的文件工具能读 cwd，两者
 * 分开才不会把凭据暴露给会话（`state/paths.ts` 里也是这么分的）。
 *
 * 宿主 `workspaceRegistry.create(path, title)` 对同一路径幂等，标题只在首次创建时
 * 生效。建不出来（老宿主没有 `create`、目录不可写、宿主一直不返回）时退回空串，
 * 行为回到「宿主默认位置」，而不是让独立模式整体不可用。
 */

import { ensurePrivateDir } from './state/files.ts';

/** 宿主 `workspaceRegistry` 里本插件用到的部分（结构类型，不 import 宿主包）。 */
export interface WorkspaceRegistry {
  list(): readonly { id?: unknown; title?: unknown; path?: unknown }[];
  /** 建或复用一个工作区（同一路径幂等）；老宿主没有这个方法时只读列表。 */
  create?(path: string, title?: string): Promise<{ id?: unknown }>;
}

/** 面板的工作区候选；宿主没有这个服务时 available=false，面板显示原因。 */
export interface WorkspaceCatalog {
  items: { id: string; title: string; path: string }[];
  available: boolean;
  reason?: string;
  /** 插件自动创建的默认工作区 id；还没建好或建不出来时为空串。 */
  defaultId: string;
}

/** 默认工作区标题：面板与宿主工作区列表里显示的名字。 */
export const DEFAULT_WORKSPACE_TITLE = '飞书会话';

const DEFAULT_ENSURE_TIMEOUT_MS = 5_000;

export interface WorkspacesOptions {
  /** 默认工作区目录：会话的 cwd，与插件状态目录分开。 */
  dir: string;
  logger?: { warn?(...args: unknown[]): unknown };
  /** 等宿主建工作区的上限；超时当失败，下次调用重试。 */
  timeoutMs?: number;
}

export class Workspaces {
  readonly #dir: string;
  readonly #logger: WorkspacesOptions['logger'];
  readonly #timeoutMs: number;
  #registry: WorkspaceRegistry | null = null;
  #defaultId = '';
  #ensuring: Promise<string> | null = null;
  /** 服务重新接入时自增：在途的旧请求回来后不再写进新状态。 */
  #generation = 0;

  constructor(options: WorkspacesOptions) {
    this.#dir = options.dir;
    this.#logger = options.logger;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS;
  }

  /** 宿主工作区服务换了（重建/解挂）：丢掉旧 id，下次调用重新登记。 */
  attach(registry: WorkspaceRegistry | null): void {
    this.#registry = registry;
    this.#generation += 1;
    this.#defaultId = '';
    this.#ensuring = null;
    // 提前建好：第一条消息进来时不必再等宿主；失败只记日志，面板仍可选手动工作区。
    if (registry !== null) void this.ensureDefault();
  }

  /** 已建好的默认工作区 id；没建好（或建不出来）时为空串。 */
  get defaultId(): string {
    return this.#defaultId;
  }

  /** 面板的候选列表；读失败时带上原因，让面板能说清楚为什么选不了。 */
  catalog(): WorkspaceCatalog {
    const registry = this.#registry;
    if (registry === null || typeof registry.list !== 'function') {
      return { items: [], available: false, reason: '宿主不提供工作区服务', defaultId: this.#defaultId };
    }
    try {
      const items = registry.list().flatMap((workspace) => {
        const id = typeof workspace?.id === 'string' ? workspace.id : '';
        if (id === '') return [];
        const title = typeof workspace.title === 'string' && workspace.title.trim() !== '' ? workspace.title.trim() : id;
        const path = typeof workspace.path === 'string' ? workspace.path : '';
        return [{ id, title, path }];
      });
      return { items, available: true, defaultId: this.#defaultId };
    } catch {
      return { items: [], available: false, reason: '读取宿主工作区失败', defaultId: this.#defaultId };
    }
  }

  /** 建或复用默认工作区；并发调用共用同一个请求。失败返回空串，下次重试。 */
  async ensureDefault(): Promise<string> {
    if (this.#defaultId !== '') return this.#defaultId;
    if (this.#ensuring !== null) return this.#ensuring;

    const registry = this.#registry;
    const create = registry?.create;
    if (registry === null || typeof create !== 'function') return '';

    const generation = this.#generation;
    const task = (async () => {
      try {
        // 工作区路径必须是已存在的绝对目录。
        await ensurePrivateDir(this.#dir);
        const workspace = await withTimeout(
          create.call(registry, this.#dir, DEFAULT_WORKSPACE_TITLE),
          this.#timeoutMs,
          `等宿主创建工作区超过 ${this.#timeoutMs}ms`,
        );
        const id = typeof workspace?.id === 'string' ? workspace.id : '';
        if (id === '') throw new Error('宿主没有返回工作区 id');
        if (generation !== this.#generation) return '';
        this.#defaultId = id;
        return id;
      } catch (error) {
        if (generation !== this.#generation) return '';
        this.#logger?.warn?.('自动创建默认工作区失败', error instanceof Error ? error.message : String(error));
        return '';
      } finally {
        if (generation === this.#generation) this.#ensuring = null;
      }
    })();

    this.#ensuring = task;
    return task;
  }
}

/** 超时后拒绝，但保留原请求的结局处理：晚到的成功/失败不会再抛未处理 rejection。 */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
