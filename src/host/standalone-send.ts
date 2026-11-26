/**
 * `/send` 与 `/queue` 的编排：定位会话、分流当前会话、提交并登记回答观察。
 *
 * 与 `standalone.ts` 分开，避免会话编排被命令细节撑大；这里只通过端口拿状态与
 * 发消息，不自己持有任何字段。
 */

import { randomUUID } from 'node:crypto';

import type { LarkLogger } from './lark/connection.ts';
import { buildContent } from './prompt-content.ts';
import type { OwnerMessageDraft } from './protocol.ts';
import {
  QUEUE_USAGE,
  SEND_USAGE,
  frontMissingHint,
  isFrontRef,
  loadSessionCatalog,
  resolveSessionRef,
  sessionLabel,
} from './session-list.ts';
import type { SendWatcher } from './session-watch.ts';
import type { StandaloneCommand } from './standalone-command.ts';
import type { BusyMode, StandaloneController } from './standalone-types.ts';
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
  /** 当前会话的提交；`mode` 由调用方决定是否强制排队。返回失败原因，成功为 null。 */
  submitCurrent: (text: string, draft: OwnerMessageDraft, mode: BusyMode) => Promise<string | null>;
  /** 当前会话的完成对齐（`DoneAlign`）；`waiting` 表示它排在别人正跑的那一轮之后。 */
  pushAlign: (platformMessageId: string, mode: BusyMode, waiting: boolean) => void;
  /** 面板的「回合内插话」设置；`/queue` 会绕过它。 */
  busyMode: () => BusyMode;
  /** 当前绑定会话是否正在跑一轮（比列表快照更准，供 DONE 对齐与提示用）。 */
  isRunning: () => boolean;
  reply: (text: string) => Promise<boolean>;
}

/**
 * 执行 `/send` 或 `/queue`；返回 `true` 表示还有一轮回答在路上（先别给命令消息补 `DONE`）。
 *
 * 目标是当前会话时走普通提交，回答由绑定会话的回合逻辑发回；目标是其它会话时
 * 登记观察者，等它 `turn/end` 再发回来。两条路都不切换绑定。
 */
export async function handleSendCommand(
  command: Extract<StandaloneCommand, { kind: 'send' | 'queue' }>,
  messageId: string,
  draft: OwnerMessageDraft,
  host: SendCommandHost,
): Promise<boolean> {
  const forceQueue = command.kind === 'queue';
  const images = draft.images ?? [];
  if (command.ref === '' || (command.text === '' && images.length === 0)) {
    await host.reply(forceQueue ? QUEUE_USAGE : SEND_USAGE);
    return false;
  }
  // `/queue` 固定排队；`/send` 与普通消息一样遵循面板设置。
  const mode: BusyMode = forceQueue ? 'queue' : host.busyMode();

  const controller = host.controller();
  if (controller === null) {
    await host.reply('独立模式不可用：宿主没有会话控制器。');
    return false;
  }

  const binding = await host.bindings.get();
  const front = frontSessionOf(binding);
  const wantFront = isFrontRef(command.ref);
  if (wantFront && front === null) {
    await host.reply(frontMissingHint(binding !== null));
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
        `前台会话「${sessionLabel(front?.title)}」不在了；发 /new 开新会话，或 /switch <序号> 换到其它会话。`,
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

  // 当前绑定会话的回合状态由事件维护，比列表快照准；提交前先取，免得被这一轮的 turn/start 覆盖。
  if (binding !== null && binding.sessionId === picked.sessionId) {
    const running = host.isRunning();
    const error = await host.submitCurrent(command.text, draft, mode);
    if (error !== null) {
      await host.reply(error);
      return false;
    }
    // 排队且目标正忙时，下一个 turn/end 属于它排在后面的那一轮，不能提前结算。
    host.pushAlign(messageId, mode, mode === 'queue' && running);
    await host.reply(`已交给当前会话「${picked.title || '未命名会话'}」${waitNote(running, mode)}，回答照常发回这里。`);
    return true;
  }

  // 其它会话只能看列表快照，提示按它写；DONE 对齐不依赖它。
  const running = catalog.sessions.find((row) => row.sessionId === picked.sessionId)?.running === true;

  // 排队时先用 watcher 的 pendingStart 跳过目标当前那一轮；turn/start 会清掉它，
  // 所以这里不依赖快照的 running（快照可能已经过期）。插话进入当前回合，不跳过。
  const queued = mode === 'queue';
  const tracked = host.watcher.track(
    picked.sessionId,
    picked.title,
    { chatId: host.chatId, replyTo: messageId, platformMessageId: messageId },
    queued,
  );
  if (tracked !== 'ok') {
    await host.reply(
      tracked === 'busy'
        ? `已经有一条投递在等「${picked.title || '未命名会话'}」的回答，等它回来再发。`
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
        mode,
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      AbortSignal.timeout(host.submitTimeoutMs),
    );
    if (accepted.accepted === false) throw new Error('会话没有接受这条消息');
  } catch (error) {
    host.watcher.remove(picked.sessionId);
    const detail = error instanceof Error ? error.message : String(error);
    host.logger.warn?.('独立模式投递提交失败', detail);
    await host.reply(`没能把消息交给会话：${detail}`);
    return false;
  }

  const dropped = (draft.files?.length ?? 0) > 0 ? '；文件没有转发' : '';
  await host.reply(`已交给会话「${picked.title || '未命名会话'}」${waitNote(running, mode)}${dropped}，这一轮结束后把回答发给你。`);
  return true;
}

/** 目标正在跑时的提示：排队说等下一轮，插话说进当前回合。 */
function waitNote(running: boolean, mode: BusyMode): string {
  if (!running) return '';
  return mode === 'queue' ? '，它正在运行，排在当前这一轮之后' : '，它正在运行，这条会插进当前回合';
}

