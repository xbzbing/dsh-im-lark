/**
 * `/sessions` 的编排：列一份新快照，前台会话不参与编号。
 *
 * 与 `standalone-send.ts` / `standalone-switch.ts` 对称：只通过端口拿状态与发消息，
 * 不持有字段。前台固定是序号 0，所以快照里要把它剔掉，否则切回前台后列表会再套一个自己。
 */

import { SESSION_PAGE_SIZE, frontMissingHint, loadSessionCatalog, renderSessionList } from './session-list.ts';
import type { StandaloneController } from './standalone-types.ts';
import { frontSessionOf } from './state/direct.ts';
import type { DirectBindingStore } from './state/direct.ts';
import { MAX_LISTING } from './state/listing.ts';
import type { ListingStore } from './state/listing.ts';

export interface SessionsCommandHost {
  controller: () => StandaloneController | null;
  listing: ListingStore;
  bindings: DirectBindingStore;
  reply: (text: string) => Promise<boolean>;
}

/** 执行 `/sessions [页码]`；每次列出一份新快照并落盘。 */
export async function handleSessionsCommand(page: number | undefined, host: SessionsCommandHost): Promise<void> {
  const binding = await host.bindings.get();
  const front = frontSessionOf(binding);
  const catalog = await loadSessionCatalog(
    host.controller(),
    binding === null ? {} : { keepId: binding.sessionId },
  );
  if (!catalog.available) {
    await host.reply(catalog.reason ?? '读取会话列表失败。');
    return;
  }

  const others = catalog.sessions.filter((row) => row.sessionId !== front?.sessionId);
  const visible = others.slice(0, MAX_LISTING);
  await host.listing.set(visible);
  if (visible.length === 0) {
    await host.reply(
      front === null
        ? frontMissingHint(binding !== null)
        : '没有其它会话。发 `/switch 0` 回前台，或 `/send 0 <内容>` 直接发到前台。',
    );
    return;
  }

  const pages = Math.max(1, Math.ceil(visible.length / SESSION_PAGE_SIZE));
  const shown = Math.min(Math.max(1, page ?? 1), pages);
  const offset = (shown - 1) * SESSION_PAGE_SIZE;
  await host.reply(renderSessionList({
    rows: visible.slice(offset, offset + SESSION_PAGE_SIZE),
    page: shown,
    pages,
    offset,
    total: visible.length,
    ...(binding === null ? {} : { currentId: binding.sessionId }),
    ...(front === null ? {} : { hasFront: true }),
    ...(others.length > visible.length ? { truncated: true } : {}),
  }));
}
