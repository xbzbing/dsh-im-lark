/**
 * 独立模式的会话目录：`/sessions` 的表格、序号快照与命令行里的会话定位。
 *
 * 序号只按最近一次 `/sessions` 的快照解释（快照由 `state/listing.ts` 落盘），会话 id
 * 支持完整或唯一前缀。子代理会话与从未用过的空会话不列：主人不该从飞书接管子任务，
 * 也不该对着一个空会话发消息。
 */

import type { ListingEntry } from './state/listing.ts';

/** 列表超时：宿主读盘慢时宁可报「读不到」，也不把命令卡住。 */
const LIST_TIMEOUT_MS = 10_000;

/** `/sessions` 每页几个会话。 */
export const SESSION_PAGE_SIZE = 10;

const TITLE_MAX = 32;
const ID_SHOWN = 8;
const SESSION_PREFIX = 'session-';

export const SEND_USAGE = '用法：`/send <序号、0 或会话 id> <内容>`。先发 `/sessions` 看序号（`0` 是前台会话）。';
export const SWITCH_USAGE = '用法：`/switch <序号、0、front 或会话 id>`；`0` 与 `front` 回到前台会话。';

/** 没有前台会话时的提示：有绑定说明是旧记录丢了，不能再让人发消息等新建。 */
export function frontMissingHint(hasBinding: boolean): string {
  return hasBinding
    ? '没有前台会话记录：发 /new 开新会话。'
    : '还没有前台会话：先发一条消息建会话。';
}

/** 前台会话的固定引用：`0` 或 `front`（大小写不敏感）。 */
export function isFrontRef(ref: string): boolean {
  const token = ref.trim().toLowerCase();
  return token === '0' || token === 'front';
}

/** 宿主 `sessionController.list` 里本模块用到的形状（结构类型）。 */
export interface SessionRow {
  sessionId?: unknown;
  running?: unknown;
  origin?: unknown;
  parentSessionId?: unknown;
  blank?: unknown;
  projections?: { values?: Record<string, unknown> } | null;
}

export interface SessionLister {
  list?(request: Record<string, unknown>, signal: AbortSignal): Promise<{ items?: readonly SessionRow[] }>;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  running: boolean;
}

export interface SessionCatalog {
  sessions: SessionSummary[];
  available: boolean;
  reason?: string;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function titleOf(row: SessionRow): string {
  const title = row.projections?.values?.title;
  return typeof title === 'string' ? title.trim() : '';
}

/** 一行摘要 → 可列出的会话；不满足条件的返回 null。 */
function toSummary(row: SessionRow, keepId: string): SessionSummary | null {
  const sessionId = asText(row.sessionId);
  if (sessionId === '') return null;
  // 绑定会话即使还是空的也要列出来：主人得看得见它。
  if (sessionId !== keepId) {
    if (asText(row.origin) === 'subagent' || asText(row.parentSessionId) !== '') return null;
    if (row.blank === true) return null;
  }
  return { sessionId, title: titleOf(row), running: row.running === true };
}

export async function loadSessionCatalog(
  lister: SessionLister | null,
  options: { keepId?: string; timeoutMs?: number } = {},
): Promise<SessionCatalog> {
  if (lister === null || typeof lister.list !== 'function') {
    return { sessions: [], available: false, reason: '宿主不提供会话列表。' };
  }
  try {
    const value = await lister.list({}, AbortSignal.timeout(options.timeoutMs ?? LIST_TIMEOUT_MS));
    const items = Array.isArray(value?.items) ? value.items : [];
    const keepId = options.keepId?.trim() ?? '';
    const sessions: SessionSummary[] = [];
    for (const row of items) {
      const summary = toSummary(row ?? {}, keepId);
      if (summary !== null) sessions.push(summary);
    }
    return { sessions, available: true };
  } catch (error) {
    return {
      sessions: [],
      available: false,
      reason: `读取会话列表失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface SessionListView {
  rows: readonly SessionSummary[];
  page: number;
  pages: number;
  /** 本页第一行在快照里的下标。 */
  offset: number;
  /** 快照里的会话数（翻页能翻到的）。 */
  total: number;
  currentId?: string;
  /** 有前台会话时，footer 才提示 `/switch 0` / `/send 0`。 */
  hasFront?: boolean;
  /** 宿主的会话比快照多，后面的没有列出。 */
  truncated?: boolean;
}

export function renderSessionList(view: SessionListView): string {
  const heading = view.pages > 1
    ? `**最近会话**（共 ${view.total} 个，第 ${view.page}/${view.pages} 页）`
    : `**最近会话**（共 ${view.total} 个）`;
  const rows = view.rows.map((row, index) => {
    const title = tableCell(row.title, TITLE_MAX) || '未命名会话';
    const mark = row.sessionId === view.currentId ? '（当前）' : '';
    return `| ${view.offset + index + 1} | ${title}${mark} | \`${shortSessionId(row.sessionId)}\` | ${row.running ? '**运行中**' : '空闲'} |`;
  });
  const lines = [
    heading,
    '',
    '| # | 会话 | id | 状态 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ];
  if (view.truncated === true) lines.push('只列最近 100 个会话，更多请到 DSH 网页端查看。', '');
  if (view.page < view.pages) lines.push(`发 \`/sessions ${view.page + 1}\` 看下一页。`, '');
  const frontTip = view.hasFront === true ? '`/switch 0` 回到前台会话，`/send 0` 发到前台；' : '';
  lines.push(`发 \`/switch <序号>\` 切换会话，${frontTip}\`/send <序号>\` 发到某个会话，那一轮的回答回到这里。序号在下次发 \`/sessions\` 之前不变。`);
  return lines.join('\n');
}

export type ResolvedSession = { sessionId: string; title: string };

/**
 * 按序号或会话 id 定位。
 *
 * 序号只按快照解释，不拿实时列表兜底：没列过的序号是盲猜。会话 id（完整或唯一前缀）
 * 按当前列表找；不足 4 位的纯数字只当序号。
 */
export function resolveSessionRef(
  ref: string,
  listing: readonly ListingEntry[],
  catalog: SessionCatalog,
): ResolvedSession | { miss: string } {
  const token = ref.trim();
  if (token === '') return { miss: SEND_USAGE };

  if (/^\d+$/.test(token)) {
    const index = Number.parseInt(token, 10);
    if (listing.length > 0 && index >= 1 && index <= listing.length) {
      const entry = listing[index - 1]!;
      return { sessionId: entry.sessionId, title: entry.title };
    }
    if (token.length < 4) {
      return {
        miss: listing.length > 0
          ? `序号 ${token} 不在你上次 /sessions 的列表里（共 ${listing.length} 个），发 /sessions 重新列出。`
          : '还没列过会话：先发 /sessions 看序号，或直接用会话 id 的前几位。',
      };
    }
  }

  if (!catalog.available) return { miss: catalog.reason ?? '读取会话列表失败。' };
  const matches = catalog.sessions.filter((row) => sessionIdMatches(row.sessionId, token));
  if (matches.length === 1) return { sessionId: matches[0]!.sessionId, title: matches[0]!.title };
  if (matches.length > 1) return { miss: `有多条会话匹配「${token}」，请多写几位 id。` };
  return { miss: `找不到「${token}」对应的会话，先发 /sessions 看一眼序号（也可以用会话 id 的前几位）。` };
}

/** 会话 id 是否匹配命令行里给的完整 id 或前缀；表格里的短 id 也认。 */
export function sessionIdMatches(sessionId: string, token: string): boolean {
  const id = sessionId.trim();
  const value = token.trim();
  if (id === '' || value === '') return false;
  if (id === value || id.startsWith(value)) return true;
  return id.startsWith(SESSION_PREFIX) && id.slice(SESSION_PREFIX.length).startsWith(value);
}

/** 表格里显示的会话 id：去掉 `session-` 前缀，只留前 8 位。 */
export function shortSessionId(sessionId: string): string {
  const id = sessionId.startsWith(SESSION_PREFIX) ? sessionId.slice(SESSION_PREFIX.length) : sessionId;
  return id.slice(0, ID_SHOWN);
}

const UNTITLED_SESSION = '未命名会话';
const SESSION_LABEL_MAX = 32;

/** 回复里的会话名：压平换行与连续空白，过长截断。 */
export function sessionLabel(title: string | undefined): string {
  const flat = (title ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return UNTITLED_SESSION;
  return flat.length > SESSION_LABEL_MAX ? `${flat.slice(0, SESSION_LABEL_MAX - 1)}…` : flat;
}

/** 放进 `**…**` 里的会话名：转义会打断强调的 Markdown 字符。 */
export function markLabel(label: string): string {
  return label.replace(/[\\`*_[\]<>|~]/g, '\\$&');
}

/** 表格单元格：换行压成空格、`|` 转义（否则会被当成列分隔），过长截断。 */
function tableCell(value: string, max = Infinity): string {
  const flat = value.replace(/\s*\r?\n\s*/g, ' ').trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return clipped.replace(/\|/g, '\\|');
}
