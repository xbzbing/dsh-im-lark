/**
 * `/send` 的编排：定位会话、分流当前会话、提交并登记回答观察。
 *
 * 与 `standalone.ts` 分开，避免会话编排被命令细节撑大；这里只通过端口拿状态与
 * 发消息，不自己持有任何字段。
 */

import { randomUUID } from 'node:crypto';

import type { LarkLogger } from './lark/connection.ts';
import { buildContent } from './prompt-content.ts';
import type { OwnerMessageDraft } from './protocol.ts';
import { SEND_USAGE, isFrontRef, loadSessionCatalog, resolveSessionRef } from './session-list.ts';
import type { SendWatcher } from './session-watch.ts';
import type { StandaloneController } from './standalone-types.ts';
import { frontSessionOf } from './state/direct.ts';
import type { DirectBindingStore } from './state/direct.ts';
import type { ListingStore } from './state/listing.ts';

export interface SendCommandHost {
  controller: () => StandaloneController | null;
  listing: ListingStore;
  bindings: DirectBindingStore;
  watcher: SendWatcher;
  /** 发命令的聊天；回答要回到这里。 */
  chatId: string;
  submitTimeoutMs: number;
  logger: LarkLogger;
  /** 当前会话的普通提交；返回失败原因，成功为 null。 */
  submitCurrent: (text: string, draft: OwnerMessageDraft) => Promise<string | null>;
  /** 当前会话的完成对齐（`DoneAlign`）。 */
  pushAlign: (platformMessageId: string) => void;
  reply: (text: string) => Promise<boolean>;
}

/**
 * 执行 `/send`；返回 `true` 表示还有一轮回答在路上（先别给命令消息补 `DONE`）。
 *
 * 目标是当前会话时走普通提交，回答由绑定会话的回合逻辑发回；目标是其它会话时
 * 登记观察者，等它 `turn/end` 再发回来。两条路都不切换绑定。
 */
export async function handleSendCommand(
  command: { ref: string; text: string },
  messageId: string,
  draft: OwnerMessageDraft,
  host: SendCommandHost,
): Promise<boolean> {
  const images = draft.images ?? [];
  if (command.ref === '' || (command.text === '' && images.length === 0)) {
    await host.reply(SEND_USAGE);
    return false;
  }

  const controller = host.controller();
  if (controller === null) {
    await host.reply('独立模式不可用：宿主没有会话控制器。');
    return false;
  }

  const binding = await host.bindings.get();
  const front = frontSessionOf(binding);
  const wantFront = isFrontRef(command.ref);
  if (wantFront && front === null) {
    await host.reply('还没有前台会话：先发一条消息建会话。');
    return false;
  }
  const frontId = front?.sessionId ?? '';

  // 0/front 不经过序号快照：前台会话不在 /sessions 的编号里。
  const catalog = await loadSessionCatalog(
    controller,
    wantFront ? { keepId: frontId } : binding === null ? {} : { keepId: binding.sessionId },
  );
  let picked: { sessionId: string; title: string };
  if (wantFront) {
    const live = catalog.sessions.find((row) => row.sessionId === frontId);
    if (catalog.available && live === undefined) {
      await host.reply(
        `前台会话「${front?.title || '未命名会话'}」不在了；发 /new 开新会话，或 /switch <序号> 换到其它会话。`,
      );
      return false;
    }
    picked = { sessionId: frontId, title: (live?.title ?? '').trim() || front?.title || '' };
  } else {
    const resolved = resolveSessionRef(command.ref, await host.listing.get(), catalog);
    if ('miss' in resolved) {
      await host.reply(resolved.miss);
      return false;
    }
    picked = resolved;
  }

  if (binding !== null && binding.sessionId === picked.sessionId) {
    const error = await host.submitCurrent(command.text, draft);
    if (error !== null) {
      await host.reply(error);
      return false;
    }
    host.pushAlign(messageId);
    await host.reply(`已交给当前会话「${picked.title || '未命名会话'}」，回答照常发回这里。`);
    return true;
  }

  // 列表里刚读到过它：运行中就走排队，先到的 turn/end 属于上一轮。
  const busy = catalog.sessions.find((row) => row.sessionId === picked.sessionId)?.running === true;
  const tracked = host.watcher.track(
    picked.sessionId,
    picked.title,
    { chatId: host.chatId, replyTo: messageId, platformMessageId: messageId },
    busy,
  );
  if (tracked !== 'ok') {
    await host.reply(
      tracked === 'busy'
        ? `已经有一个 /send 在等「${picked.title || '未命名会话'}」的回答，等它回来再发。`
        : '同时等待的会话太多，等几条回答回来再发。',
    );
    return false;
  }

  try {
    const content = buildContent(command.text, { ...draft, files: [] });
    const accepted = await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId: picked.sessionId,
        mode: 'queue',
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      AbortSignal.timeout(host.submitTimeoutMs),
    );
    if (accepted.accepted === false) throw new Error('会话没有接受这条消息');
  } catch (error) {
    host.watcher.remove(picked.sessionId);
    const detail = error instanceof Error ? error.message : String(error);
    host.logger.warn?.('独立模式 /send 提交失败', detail);
    await host.reply(`没能把消息交给会话：${detail}`);
    return false;
  }

  const queued = busy ? '，它正在运行，排在当前这一轮之后' : '';
  const dropped = (draft.files?.length ?? 0) > 0 ? '；文件没有转发' : '';
  await host.reply(`已交给会话「${picked.title || '未命名会话'}」${queued}${dropped}，这一轮结束后把回答发给你。`);
  return true;
}

