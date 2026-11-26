/**
 * `/switch` 的编排：按 `/sessions` 快照换绑当前会话，或回到前台会话。
 *
 * 与 `standalone-send.ts` 对称：只通过端口拿状态与发消息，不持有字段。换绑后的收尾
 * （清空完成对齐、复位运行态）交给 `standalone.ts` 的 `onSwitched`——那里才知道旧
 * 会话有哪些待结算的消息。
 */

import { SWITCH_USAGE, isFrontRef, loadSessionCatalog, resolveSessionRef, sessionLabel } from './session-list.ts';
import type { SendWatcher } from './session-watch.ts';
import type { StandaloneController } from './standalone-types.ts';
import { frontSessionOf } from './state/direct.ts';
import type { DirectBinding, DirectBindingStore, FrontSession } from './state/direct.ts';
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
  const front = frontSessionOf(binding);
  if (isFrontRef(token)) {
    await switchToFront(controller, front, binding, host);
    return;
  }

  const listing = await host.listing.get();

  const catalog = await loadSessionCatalog(controller, binding === null ? {} : { keepId: binding.sessionId });
  const picked = resolveSessionRef(token, listing, catalog);
  if ('miss' in picked) {
    await host.reply(picked.miss);
    return;
  }

  // 用会话 id 指到前台时也走「回前台」：不标记 switched，回复不带前缀。
  if (front !== null && picked.sessionId === front.sessionId) {
    await switchToFront(controller, front, binding, host);
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
    await host.bindings.set({ ...binding, ...named, switched: true, ...frontFields(front) });
    await host.reply(`已经在「${sessionLabel(title)}」里了，之后的回复会带上会话名。`);
    return;
  }

  await host.bindings.set({
    sessionId: picked.sessionId,
    workspaceId: '',
    ...named,
    switched: true,
    ...frontFields(front),
  });
  host.onSwitched();
  await host.reply(`已切换到「${sessionLabel(title)}」，之后的回复会带上会话名。`);
}

/** 回到前台会话：不带 `switched`，回复前缀随之消失。 */
async function switchToFront(
  controller: StandaloneController,
  front: FrontSession | null,
  binding: DirectBinding | null,
  host: SwitchCommandHost,
): Promise<void> {
  if (front === null) {
    await host.reply('还没有前台会话：先发一条消息建会话。');
    return;
  }

  if (binding !== null && binding.sessionId === front.sessionId) {
    const title = binding.title ?? front.title;
    if (binding.switched === true) {
      await host.bindings.set({
        sessionId: binding.sessionId,
        workspaceId: binding.workspaceId,
        ...(title === '' ? {} : { title }),
        frontSessionId: binding.sessionId,
        ...(title === '' ? {} : { frontTitle: title }),
      });
    }
    await host.reply(`已经在前台会话「${sessionLabel(title)}」里了。`);
    return;
  }

  if (host.watcher.has(front.sessionId)) {
    await host.reply(`「${sessionLabel(front.title)}」还有一条 /send 在等回答，等它回来再切换。`);
    return;
  }

  const catalog = await loadSessionCatalog(controller, { keepId: front.sessionId });
  const live = catalog.sessions.find((row) => row.sessionId === front.sessionId);
  if (catalog.available && live === undefined) {
    await host.reply(
      `前台会话「${sessionLabel(front.title)}」不在了；发 /new 开新会话，或 /switch <序号> 换到其它会话。`,
    );
    return;
  }

  const title = (live?.title ?? '').trim() || front.title;
  await host.bindings.set({
    sessionId: front.sessionId,
    workspaceId: '',
    ...(title === '' ? {} : { title }),
    frontSessionId: front.sessionId,
    ...(title === '' ? {} : { frontTitle: title }),
  });
  host.onSwitched();
  await host.reply(`已回到前台会话「${sessionLabel(title)}」。`);
}

function frontFields(front: FrontSession | null): Partial<DirectBinding> {
  if (front === null) return {};
  return {
    frontSessionId: front.sessionId,
    ...(front.title === '' ? {} : { frontTitle: front.title }),
  };
}
