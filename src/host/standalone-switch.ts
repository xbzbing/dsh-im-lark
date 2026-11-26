/**
 * `/switch` 的编排：按 `/sessions` 快照换绑当前会话。
 *
 * 与 `standalone-send.ts` 对称：只通过端口拿状态与发消息，不持有字段。换绑后的收尾
 * （清空完成对齐、复位运行态）交给 `standalone.ts` 的 `onSwitched`——那里才知道旧
 * 会话有哪些待结算的消息。
 */

import { SWITCH_USAGE, loadSessionCatalog, resolveSessionRef, sessionLabel } from './session-list.ts';
import type { SendWatcher } from './session-watch.ts';
import type { StandaloneController } from './standalone-types.ts';
import type { DirectBindingStore } from './state/direct.ts';
import type { ListingStore } from './state/listing.ts';

export interface SwitchCommandHost {
  controller: () => StandaloneController | null;
  listing: ListingStore;
  bindings: DirectBindingStore;
  watcher: SendWatcher;
  reply: (text: string) => Promise<boolean>;
  /** 真的换了会话（不是切到当前会话）后调用。 */
  onSwitched: () => void;
}

/** 执行 `/switch`；失败或没有换绑时只回一条说明。 */
export async function handleSwitchCommand(ref: string, host: SwitchCommandHost): Promise<void> {
  const token = ref.trim();
  if (token === '') {
    await host.reply(SWITCH_USAGE);
    return;
  }

  const controller = host.controller();
  if (controller === null) {
    await host.reply('独立模式不可用：宿主没有会话控制器。');
    return;
  }

  const binding = await host.bindings.get();
  const listing = await host.listing.get();
  if (listing.length === 0) {
    await host.reply('还没列过会话：先发 /sessions 看序号。');
    return;
  }

  const catalog = await loadSessionCatalog(controller, binding === null ? {} : { keepId: binding.sessionId });
  const picked = resolveSessionRef(token, listing, catalog);
  if ('miss' in picked) {
    await host.reply(picked.miss);
    return;
  }

  if (host.watcher.has(picked.sessionId)) {
    await host.reply(`「${sessionLabel(picked.title)}」还有一条 /send 在等回答，等它回来再切换。`);
    return;
  }

  const live = catalog.sessions.find((row) => row.sessionId === picked.sessionId);
  if (catalog.available && live === undefined) {
    await host.reply(`「${sessionLabel(picked.title)}」不在当前会话列表里了，发 /sessions 重新列出。`);
    return;
  }

  const title = (live?.title ?? '').trim() || picked.title.trim();
  const named = title === '' ? {} : { title };
  if (binding !== null && binding.sessionId === picked.sessionId) {
    // 已经在这个会话里：只打开前缀，不动待结算队列。
    await host.bindings.set({ ...binding, ...named, switched: true });
    await host.reply(`已经在「${sessionLabel(title)}」里了，之后的回复会带上会话名。`);
    return;
  }

  await host.bindings.set({ sessionId: picked.sessionId, workspaceId: '', ...named, switched: true });
  host.onSwitched();
  await host.reply(`已切换到「${sessionLabel(title)}」，之后的回复会带上会话名。`);
}
