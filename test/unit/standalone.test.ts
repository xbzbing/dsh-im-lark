import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { defaultSettings, normalizePluginConfig } from '../../src/host/config.ts';
import type { LocalSettings } from '../../src/host/config.ts';
import type { LarkInboundMessage } from '../../src/host/lark/types.ts';
import type { OutboundChannel, OutboundInput } from '../../src/host/outbound.ts';
import type { OwnerMessageDraft } from '../../src/host/protocol.ts';
import { parseCommand } from '../../src/host/standalone-command.ts';
import { StandaloneChat, buildContent, formatDuration } from '../../src/host/standalone.ts';
import type { StandaloneController } from '../../src/host/standalone.ts';
import { DirectBindingStore, OwnerStore } from '../../src/host/state/direct.ts';
import { ListingStore } from '../../src/host/state/listing.ts';
import { withTempDir } from './helpers/temp.ts';

function settingsOf(patch: Partial<LocalSettings> = {}): LocalSettings {
  const base = defaultSettings(normalizePluginConfig({}));
  return { ...base, ...patch };
}

interface Harness {
  chat: StandaloneChat;
  deliveries: OutboundInput[];
  prompts: Array<{ sessionId: string; mode: string; content: unknown[] }>;
  created: string[];
  createArgs: Array<{ workspaceId?: string }>;
  cancelled: string[];
  bindings: DirectBindingStore;
  owners: OwnerStore;
  listing: ListingStore;
}

async function harness(
  dir: string,
  options: {
    settings?: Partial<LocalSettings>;
    controller?: Partial<StandaloneController> | null;
    listRows?: Array<Record<string, unknown>>;
    workspaceId?: () => string;
    markDone?: (platformMessageId: string) => void;
    /** 出站是否报错（模拟平台发送失败）。 */
    deliverError?: string;
    /** 复用已有的序号快照（模拟插件重启）。 */
    listing?: ListingStore;
    /** 复用/替换绑定存储（测试计数用）。 */
    bindings?: DirectBindingStore;
    /** `/send` 等回答的上限与定时器（超时用例）。 */
    sendTimeoutMs?: number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): Promise<Harness> {
  const deliveries: OutboundInput[] = [];
  const prompts: Harness['prompts'] = [];
  const created: string[] = [];
  const createArgs: Harness['createArgs'] = [];
  const cancelled: string[] = [];

  const outbound = {
    async deliver(input: OutboundInput) {
      deliveries.push(input);
      if (options.deliverError !== undefined) {
        return { messageIds: [], messagesSent: 0, errorCode: 'other', error: options.deliverError };
      }
      return { messageIds: [`om_${deliveries.length}`], messagesSent: 1 };
    },
  } as unknown as OutboundChannel;

  let count = 0;
  const controller: StandaloneController | null =
    options.controller === null
      ? null
      : {
          async create(request) {
            createArgs.push({ ...request });
            count += 1;
            const sessionId = `s_${count}`;
            created.push(sessionId);
            return { sessionId };
          },
          async prompt(request) {
            prompts.push({ sessionId: request.sessionId, mode: request.mode, content: [...request.content] });
            return { accepted: true };
          },
          cancel(request) {
            cancelled.push(request.sessionId);
            return { accepted: true };
          },
          async list() {
            return { items: (options.listRows ?? []) as never };
          },
          async rename() {},
          ...options.controller,
        };

  const bindings = options.bindings ?? new DirectBindingStore({ dataDir: dir });
  const owners = new OwnerStore({ dataDir: dir });
  const listing = options.listing ?? new ListingStore({ dataDir: dir });

  const chat = new StandaloneChat({
    outbound,
    bindings,
    owners,
    listing,
    settings: () => settingsOf(options.settings),
    controller: () => controller,
    workspaceId: options.workspaceId,
    ownerLabel: () => 'abcdef',
    now: () => 1_000,
    ...(options.markDone === undefined ? {} : { markDone: options.markDone }),
    ...(options.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: options.sendTimeoutMs }),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
  });

  return { chat, deliveries, prompts, created, createArgs, cancelled, bindings, owners, listing };
}

let sequence = 0;
function inbound(fields: Partial<LarkInboundMessage> = {}): LarkInboundMessage {
  sequence += 1;
  return {
    messageId: `om_${sequence}`,
    chatId: 'oc_1',
    chatType: 'p2p',
    messageType: 'text',
    content: '{}',
    createTime: 1_000,
    senderOpenId: 'ou_owner',
    senderType: 'user',
    mentions: [],
    ...fields,
  };
}

function draftOf(message: LarkInboundMessage, text: string, overrides: Partial<OwnerMessageDraft> = {}): OwnerMessageDraft {
  return {
    messageId: `${message.chatId}:${message.messageId}`,
    sender: message.senderOpenId,
    text,
    at: message.createTime,
    platformMessageId: message.messageId,
    ...overrides,
  };
}

test('命令解析：认清单里的命令，未知命令单独标出', () => {
  assert.deepEqual(parseCommand('你好'), null);
  assert.deepEqual(parseCommand('/help'), { kind: 'help' });
  assert.deepEqual(parseCommand('/new'), { kind: 'new' });
  assert.deepEqual(parseCommand('/status'), { kind: 'status' });
  assert.deepEqual(parseCommand('/stop'), { kind: 'stop' });
  assert.deepEqual(parseCommand('/trace'), { kind: 'trace' });
  assert.deepEqual(parseCommand('/send 2 你好 世界'), { kind: 'send', ref: '2', text: '你好 世界' });
  assert.deepEqual(parseCommand('/send 2 第一行\n第二行'), { kind: 'send', ref: '2', text: '第一行\n第二行' });
  assert.deepEqual(parseCommand('/send'), { kind: 'send', ref: '', text: '' });
  assert.deepEqual(parseCommand('/send 2'), { kind: 'send', ref: '2', text: '' });
  assert.deepEqual(parseCommand('/queue 2 你好 世界'), { kind: 'queue', ref: '2', text: '你好 世界' });
  assert.deepEqual(parseCommand('/queue'), { kind: 'queue', ref: '', text: '' });
  assert.deepEqual(parseCommand('/sessions'), { kind: 'sessions' });
  assert.deepEqual(parseCommand('/sessions 3'), { kind: 'sessions', page: 3 });
  assert.deepEqual(parseCommand('/sessions abc'), { kind: 'sessions' });
  assert.deepEqual(parseCommand('/switch 1'), { kind: 'switch', ref: '1' });
  assert.deepEqual(parseCommand('/switch'), { kind: 'switch', ref: '' });
  assert.deepEqual(parseCommand('/nope'), { kind: 'unknown', name: 'nope' });
});

test('提交内容：文字在前、图片在后，文件只给提示', () => {
  const message = inbound();
  const content = buildContent('看下这个', draftOf(message, '看下这个', {
    images: [{ mediaType: 'image/png', data: 'AAAA', name: '图.png' }],
    files: [{ name: 'a.txt', data: 'AAAA' }],
  }));

  assert.deepEqual(content[0], { type: 'text', text: '看下这个' });
  assert.deepEqual(content[1], { type: 'image', mediaType: 'image/png', data: 'AAAA', name: '图.png' });
  assert.match((content[2] as { text: string }).text, /1 个文件/);
});

test('独立模式：第一条私聊认主人、建会话并提交；第二条复用同一会话', async () => {
  await withTempDir(async (dir) => {
    const { chat, prompts, created, owners } = await harness(dir.path);

    const first = inbound();
    await chat.handleInbound(first, draftOf(first, '第一句'));
    const second = inbound();
    await chat.handleInbound(second, draftOf(second, '第二句'));

    assert.deepEqual(created, ['s_1']);
    assert.deepEqual(prompts.map((item) => item.sessionId), ['s_1', 's_1']);
    assert.equal((await owners.get())?.openId, 'ou_owner');
    assert.deepEqual(bindingsOf(await chat.status()), 's_1');
  });
});

test('独立模式：已有主人时，别人的消息不处理也不进会话', async () => {
  await withTempDir(async (dir) => {
    const { chat, prompts, owners } = await harness(dir.path);
    await owners.claim('ou_owner', 'oc_1');

    const other = inbound({ senderOpenId: 'ou_stranger', chatId: 'oc_2' });
    await chat.handleInbound(other, draftOf(other, '我是谁'));

    assert.equal(prompts.length, 0);
    assert.equal((await owners.get())?.chatId, 'oc_1');
  });
});

test('独立模式：群里没认主人时不抢主人身份', async () => {
  await withTempDir(async (dir) => {
    const { chat, prompts, owners } = await harness(dir.path);
    const group = inbound({ chatType: 'group' });

    await chat.handleInbound(group, draftOf(group, '大家好'));
    assert.equal(prompts.length, 0);
    assert.equal(await owners.get(), null);
  });
});

test('独立模式：主人在群里说话，不改变主动发送的目标单聊', async () => {
  await withTempDir(async (dir) => {
    const { chat, owners } = await harness(dir.path);
    await owners.claim('ou_owner', 'oc_1');

    const group = inbound({ chatType: 'group', chatId: 'oc_group' });
    await chat.handleInbound(group, draftOf(group, '群里问一句'));

    assert.equal((await owners.get())?.chatId, 'oc_1');
  });
});

test('独立模式：/help 直接回文案，不进会话', async () => {
  await withTempDir(async (dir) => {
    const { chat, prompts, deliveries } = await harness(dir.path);
    const message = inbound();
    await chat.handleInbound(message, draftOf(message, '/help'));

    assert.equal(prompts.length, 0);
    assert.match(deliveries[0]!.text, /\/new/);
    assert.match(deliveries[0]!.text, /\/queue/);
    assert.equal(deliveries[0]!.replyTo, message.messageId);
  });
});

test('独立模式：/new 清掉绑定，下一条消息建新会话', async () => {
  await withTempDir(async (dir) => {
    const { chat, created, bindings } = await harness(dir.path);

    const first = inbound();
    await chat.handleInbound(first, draftOf(first, '开始'));
    const second = inbound();
    await chat.handleInbound(second, draftOf(second, '/new'));
    const third = inbound();
    await chat.handleInbound(third, draftOf(third, '新会话'));

    assert.deepEqual(created, ['s_1', 's_2']);
    assert.equal((await bindings.get())?.sessionId, 's_2');
  });
});

test('独立模式：/stop 调宿主 cancel', async () => {
  await withTempDir(async (dir) => {
    const { chat, cancelled } = await harness(dir.path);
    const bind = inbound();
    await chat.handleInbound(bind, draftOf(bind, '建会话'));

    const stop = inbound();
    await chat.handleInbound(stop, draftOf(stop, '/stop'));
    assert.deepEqual(cancelled, ['s_1']);
  });
});

test('独立模式：回合结束把最后一条 assistant 文本发回飞书，可带状态行', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries } = await harness(dir.path, { settings: { replyStatus: true } });
    const message = inbound();
    await chat.handleInbound(message, draftOf(message, '写个函数'));

    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '草稿' }] } } });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终回答' }] } } });
    chat.handleEvent('s_1', { type: 'model/selection', data: { model: 'deepseek-v4' } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reply = deliveries.at(-1)!;
    assert.match(reply.text, /最终回答/);
    assert.match(reply.text, /模型 deepseek-v4/);
    assert.match(reply.text, /耗时 0 秒/);
    assert.equal(reply.replyTo, message.messageId);
  });
});

test('独立模式：不是绑定会话的事件被忽略', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries } = await harness(dir.path);
    const message = inbound();
    await chat.handleInbound(message, draftOf(message, '开始'));
    const before = deliveries.length;

    chat.handleEvent('s_other', { type: 'turn/start', data: {} });
    chat.handleEvent('s_other', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '别发' }] } } });
    chat.handleEvent('s_other', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(deliveries.length, before);
  });
});

test('独立模式：排队模式映射到 queue，默认插话映射到 steer', async () => {
  await withTempDir(async (dir) => {
    const queued = await harness(dir.path, { settings: { directBusyMode: 'queue' } });
    const first = inbound();
    await queued.chat.handleInbound(first, draftOf(first, '排队'));
    assert.equal(queued.prompts[0]!.mode, 'queue');

    const steered = await harness(dir.path, { settings: { directBusyMode: 'steer' } });
    const second = inbound();
    await steered.chat.handleInbound(second, draftOf(second, '插话'));
    assert.equal(steered.prompts[0]!.mode, 'steer');
  });
});

test('独立模式：建会话带上工作区，面板选择优先于默认工作区', async () => {
  await withTempDir(async (dir) => {
    const fallback = await harness(dir.path, { workspaceId: () => 'ws-default' });
    const first = inbound();
    await fallback.chat.handleInbound(first, draftOf(first, '你好'));
    assert.deepEqual(fallback.createArgs, [{ workspaceId: 'ws-default' }]);
  });

  await withTempDir(async (dir) => {
    const chosen = await harness(dir.path, {
      settings: { directWorkspaceId: 'ws-chosen' },
      workspaceId: () => 'ws-default',
    });
    const first = inbound();
    await chosen.chat.handleInbound(first, draftOf(first, '你好'));
    assert.deepEqual(chosen.createArgs, [{ workspaceId: 'ws-chosen' }]);
  });

  await withTempDir(async (dir) => {
    const none = await harness(dir.path, { workspaceId: () => '' });
    const first = inbound();
    await none.chat.handleInbound(first, draftOf(first, '你好'));
    assert.deepEqual(none.createArgs, [{}]);
  });
});

test('独立模式：宿主没有会话控制器时明确说明消息没进会话', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries, prompts } = await harness(dir.path, { controller: null });
    const message = inbound();
    await chat.handleInbound(message, draftOf(message, '在吗'));

    assert.equal(prompts.length, 0);
    assert.match(deliveries.at(-1)!.text, /没有会话控制器/);
  });
});

test('独立模式：/sessions 列出会话与序号，不切换绑定', async () => {
  await withTempDir(async (dir) => {
    const rows = [
      { sessionId: 's_1', projections: { values: { title: '甲' } }, running: false },
      { sessionId: 's_2', projections: { values: { title: '乙' } }, running: true },
    ];
    const { chat, deliveries, bindings } = await harness(dir.path, { listRows: rows });

    // 先认主人（sessions 命令需要主人身份）。
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));

    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    const text = deliveries.at(-1)!.text;
    assert.doesNotMatch(text, /甲/);
    assert.match(text, /1 \| 乙/);
    assert.doesNotMatch(text, /（当前）/);
    assert.match(text, /运行中/);
    assert.match(text, /\/send 0/);
    assert.equal((await bindings.get())?.sessionId, 's_1');

    // 页码只翻页，不再换会话。
    const page = inbound();
    await chat.handleInbound(page, draftOf(page, '/sessions 2'));
    assert.equal((await bindings.get())?.sessionId, 's_1');
  });
});

test('独立模式：/switch 按快照序号切换，之后的回复带会话名前缀', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries, bindings, prompts } = await harness(dir.path, { listRows: rowsOf() });

    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));

    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));

    const binding = await bindings.get();
    assert.equal(binding?.sessionId, 's_2');
    assert.equal(binding?.title, '乙');
    assert.equal(binding?.switched, true);
    assert.match(deliveries.at(-1)!.text, /^\*\*乙>\*\*\n\n已切换到「乙」/);

    const ask = inbound();
    await chat.handleInbound(ask, draftOf(ask, '在吗'));
    assert.equal(prompts.at(-1)!.sessionId, 's_2');
    chat.handleEvent('s_2', { type: 'turn/start', data: {} });
    chat.handleEvent('s_2', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在' }] } } });
    chat.handleEvent('s_2', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(deliveries.at(-1)!.text, /^\*\*乙>\*\*\n\n在/);
  });
});

test('独立模式：/switch 的前缀跨重启保留，/new 后消失', async () => {
  await withTempDir(async (dir) => {
    const first = await harness(dir.path, { listRows: rowsOf() });
    const hello = inbound();
    await first.chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await first.chat.handleInbound(list, draftOf(list, '/sessions'));
    const sw = inbound();
    await first.chat.handleInbound(sw, draftOf(sw, '/switch 1'));

    const restarted = await harness(dir.path, { listRows: rowsOf() });
    const status = inbound();
    await restarted.chat.handleInbound(status, draftOf(status, '/status'));
    assert.match(restarted.deliveries.at(-1)!.text, /^\*\*乙>\*\*/);

    const reset = inbound();
    await restarted.chat.handleInbound(reset, draftOf(reset, '/new'));
    assert.equal(await restarted.bindings.get(), null);
    const help = inbound();
    await restarted.chat.handleInbound(help, draftOf(help, '/help'));
    assert.doesNotMatch(restarted.deliveries.at(-1)!.text, /^\*\*/);
  });
});

test('独立模式：/switch 拒绝还有投递在等回答的会话', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries, bindings } = await harness(dir.path, { listRows: rowsOf() });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));

    const send = inbound();
    await chat.handleInbound(send, draftOf(send, '/send 1 你好'));
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));

    assert.match(deliveries.at(-1)!.text, /还有一条投递在等回答/);
    assert.equal((await bindings.get())?.sessionId, 's_1');
  });
});

test('独立模式：/switch 到当前会话只打开前缀，不清待结算队列', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat, deliveries } = await harness(dir.path, { listRows: rowsOf(), markDone: (id) => marked.push(id) });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));

    // 先切到 s_2，再在同一会话里切一次：这次不能清掉待结算队列。
    const first = inbound();
    await chat.handleInbound(first, draftOf(first, '/switch 1'));
    const queued = inbound();
    await chat.handleInbound(queued, draftOf(queued, '排队的问题'));
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));
    assert.match(deliveries.at(-1)!.text, /^\*\*乙>\*\*/);

    chat.handleEvent('s_2', { type: 'turn/start', data: {} });
    chat.handleEvent('s_2', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } });
    chat.handleEvent('s_2', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(marked.includes(queued.messageId), '同一会话切换不能丢掉待结算的消息');
  });
});

test('独立模式：/switch 的目标已不在当前列表里时拒绝', async () => {
  await withTempDir(async (dir) => {
    const rows = rowsOf();
    const { chat, deliveries, bindings } = await harness(dir.path, { listRows: rows });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));

    rows.pop();
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));

    assert.match(deliveries.at(-1)!.text, /不在当前会话列表里/);
    assert.equal((await bindings.get())?.sessionId, 's_1');
  });
});

test('独立模式：session/title 更新绑定标题，前缀跟着变', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries } = await harness(dir.path, { listRows: rowsOf() });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));

    chat.handleEvent('s_2', { type: 'session/title', data: { title: '新名字' } });
    await chat.drain();

    const status = inbound();
    await chat.handleInbound(status, draftOf(status, '/status'));
    assert.match(deliveries.at(-1)!.text, /^\*\*新名字>\*\*/);
  });
});

test('独立模式：/sessions 不显示前台会话，切走后只列其它会话', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries } = await harness(dir.path, { listRows: rowsOf() });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));

    const again = inbound();
    await chat.handleInbound(again, draftOf(again, '/sessions'));
    const text = deliveries.at(-1)!.text;
    assert.doesNotMatch(text, /甲/);
    assert.match(text, /1 \| 乙（当前）/);
  });
});

test('独立模式：/switch 0 回到前台会话并去掉前缀', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries, bindings, prompts } = await harness(dir.path, { listRows: rowsOf() });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));
    assert.match(deliveries.at(-1)!.text, /^\*\*乙>\*\*/);

    const back = inbound();
    await chat.handleInbound(back, draftOf(back, '/switch 0'));
    const binding = await bindings.get();
    assert.equal(binding?.sessionId, 's_1');
    assert.equal(binding?.switched, undefined);
    assert.equal(binding?.frontSessionId, 's_1');
    assert.doesNotMatch(deliveries.at(-1)!.text, /^\*\*/);
    assert.match(deliveries.at(-1)!.text, /已回到前台会话「甲」/);

    const ask = inbound();
    await chat.handleInbound(ask, draftOf(ask, '继续'));
    assert.equal(prompts.at(-1)!.sessionId, 's_1');
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.doesNotMatch(deliveries.at(-1)!.text, /^\*\*/);
  });
});

test('独立模式：/switch front 与 /switch 0 等价', async () => {
  await withTempDir(async (dir) => {
    const { chat, bindings } = await harness(dir.path, { listRows: rowsOf() });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));

    const back = inbound();
    await chat.handleInbound(back, draftOf(back, '/switch FRONT'));
    assert.equal((await bindings.get())?.sessionId, 's_1');
    assert.equal((await bindings.get())?.switched, undefined);
  });
});

test('独立模式：/new 后没有前台会话，/switch 0 明确提示', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries, bindings } = await harness(dir.path);
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const reset = inbound();
    await chat.handleInbound(reset, draftOf(reset, '/new'));
    assert.equal(await bindings.get(), null);
    const back = inbound();
    await chat.handleInbound(back, draftOf(back, '/switch 0'));
    assert.match(deliveries.at(-1)!.text, /还没有前台会话/);
  });
});

test('独立模式：前台会话不在了，/switch 0 提示 /new', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries } = await harness(dir.path, { listRows: rowsOf().slice(1) });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));

    const back = inbound();
    await chat.handleInbound(back, draftOf(back, '/switch 0'));
    assert.match(deliveries.at(-1)!.text, /前台会话「飞书 · abcdef」不在了/);
    assert.match(deliveries.at(-1)!.text, /\/new/);
  });
});

test('独立模式：前台会话不在了，/send 0 提示 /new 且不提交', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries, prompts } = await harness(dir.path, { listRows: rowsOf().slice(1) });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));
    assert.equal(prompts.length, 1);

    const send = inbound();
    await chat.handleInbound(send, draftOf(send, '/send 0 你好'));
    assert.match(deliveries.at(-1)!.text, /前台会话「飞书 · abcdef」不在了/);
    assert.equal(prompts.length, 1);
  });
});

test('独立模式：切走后前台标题更新，/switch 0 用新标题', async () => {
  await withTempDir(async (dir) => {
    const rows = rowsOf();
    const { chat, deliveries, bindings } = await harness(dir.path, { listRows: rows });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch 1'));

    chat.handleEvent('s_1', { type: 'session/title', data: { title: '新前台' } });
    await chat.drain();
    assert.equal((await bindings.get())?.frontTitle, '新前台', '标题事件先落到前台字段');
    // 下一次 list 会读到新标题；真实控制器里 title 事件与 list 同源。
    rows[0] = { ...rows[0], projections: { values: { title: '新前台' } } };

    const back = inbound();
    await chat.handleInbound(back, draftOf(back, '/switch 0'));
    assert.equal((await bindings.get())?.frontTitle, '新前台');
    assert.match(deliveries.at(-1)!.text, /已回到前台会话「新前台」/);
  });
});

test('独立模式：/trace 回上一条的模型与耗时', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries } = await harness(dir.path);
    const first = inbound();
    await chat.handleInbound(first, draftOf(first, '开始'));
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好了' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const trace = inbound();
    await chat.handleInbound(trace, draftOf(trace, '/trace'));
    assert.match(deliveries.at(-1)!.text, /上一条回答/);
    assert.match(deliveries.at(-1)!.text, /耗时/);
  });
});

test('时长格式化：秒与分', () => {
  assert.equal(formatDuration(1_200), '1 秒');
  assert.equal(formatDuration(65_000), '1 分 5 秒');
});

function bindingsOf(status: { bound: boolean; sessionId?: string }): string | undefined {
  return status.bound ? status.sessionId : undefined;
}

function rowsOf(): Array<Record<string, unknown>> {
  return [
    { sessionId: 's_1', projections: { values: { title: '甲' } }, running: false },
    { sessionId: 's_2', projections: { values: { title: '乙' } }, running: false },
  ];
}

test('独立模式：回合结束回复成功后给原消息补 DONE，提交入队不提前打', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { markDone: (id) => marked.push(id) });
    const message = inbound();
    await chat.handleInbound(message, draftOf(message, '写个函数'));
    assert.deepEqual(marked, [], '提交入队不算完成');

    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(marked, [message.messageId]);
  });
});

test('独立模式：回合没给回答不打 DONE，队列对齐到下一条被回答的消息', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { markDone: (id) => marked.push(id) });

    const first = inbound();
    await chat.handleInbound(first, draftOf(first, '没回答的消息'));
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [], '空回答不给假的完成信号');

    const second = inbound();
    await chat.handleInbound(second, draftOf(second, '有回答的'));
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [second.messageId], '标记对齐到真正被回答的那条');
  });
});

test('独立模式：命令处理完当场补 DONE', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { markDone: (id) => marked.push(id) });
    const message = inbound();
    await chat.handleInbound(message, draftOf(message, '/help'));
    assert.deepEqual(marked, [message.messageId]);
  });
});

test('独立模式：提交失败的通知不打 DONE', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { controller: null, markDone: (id) => marked.push(id) });
    const message = inbound();
    await chat.handleInbound(message, draftOf(message, '发不出去'));
    assert.deepEqual(marked, []);
  });
});

test('独立模式：排队模式两条在队时，一条 turn/end 只结算队头', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { settings: { directBusyMode: 'queue' }, markDone: (id) => marked.push(id) });
    const first = inbound();
    const second = inbound();
    await chat.handleInbound(first, draftOf(first, '第一条'));
    await chat.handleInbound(second, draftOf(second, '第二条'));

    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答一' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [first.messageId], '第二条还没轮到');

    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答二' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [first.messageId, second.messageId]);
  });
});

test('独立模式：插话模式下两条被同一轮吸收，一次 turn/end 一起结算', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { settings: { directBusyMode: 'steer' }, markDone: (id) => marked.push(id) });
    const first = inbound();
    await chat.handleInbound(first, draftOf(first, '第一条'));

    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    // 回合进行中又发一条：steer 在下一个步骤边界被这一轮吸收，不会再有自己的 turn/end。
    const second = inbound();
    await chat.handleInbound(second, draftOf(second, '插一句'));

    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '两条一起答' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [first.messageId, second.messageId], '两条都被这一轮回答，都要结算');
  });
});

test('独立模式：排队消息排在别人那一轮后面时，不随那一轮打 DONE', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { settings: { directBusyMode: 'queue' }, markDone: (id) => marked.push(id) });

    // 第一条自己开一轮，先正常结算掉，避免它挡在队头。
    const first = inbound();
    await chat.handleInbound(first, draftOf(first, '第一条'));
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答一' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [first.messageId]);

    // 另一轮已经在跑（不是这条消息开的），此时排队的消息还没轮到。
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    const second = inbound();
    await chat.handleInbound(second, draftOf(second, '排队等下一轮'));
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '别人那轮的答' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [first.messageId], '这一轮不是它开的，不能提前打 DONE');

    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '轮到它了' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [first.messageId, second.messageId]);
  });
});

test('独立模式：排队消息排的那一轮结束时，下一条排队消息自己开始', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { settings: { directBusyMode: 'queue' }, markDone: (id) => marked.push(id) });

    const first = inbound();
    await chat.handleInbound(first, draftOf(first, '第一条'));
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });

    // 第一条跑着时又排一条：它要等第一条那轮结束才轮到自己。
    const second = inbound();
    await chat.handleInbound(second, draftOf(second, '第二条'));

    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答一' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [first.messageId], '第二条排在第一条之后，这轮不能结算它');

    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答二' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [first.messageId, second.messageId], '轮到它自己那轮，必须结算');
  });
});

test('独立模式：排队期间插进那一轮的说法，随那一轮结算而不是随排队那条', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, {
      listRows: [{ sessionId: 's_1', projections: { values: { title: '甲' } } }],
      markDone: (id) => marked.push(id),
    });

    // 先把建会话那条结算掉，避免它挡在队头。
    const first = inbound();
    await chat.handleInbound(first, draftOf(first, '第一条'));
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答一' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, [first.messageId]);

    // 默认插话设置下，/queue 仍然固定排队；后面这条普通消息是 steer。
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    const queued = inbound();
    await chat.handleInbound(queued, draftOf(queued, '/queue 0 排队'));
    const steered = inbound();
    await chat.handleInbound(steered, draftOf(steered, '插一句'));

    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '两条一起答' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(marked.includes(steered.messageId), '插话被这一轮吸收，应随这一轮结算');
    assert.ok(!marked.includes(queued.messageId), '排队那条还没轮到');

    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '排队答' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(marked.includes(queued.messageId), '排队那条自己那轮结束才结算');
  });
});

test('独立模式：回复发送失败时不打 DONE（即使有回答）', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { deliverError: '平台限流', markDone: (id) => marked.push(id) });
    const message = inbound();
    await chat.handleInbound(message, draftOf(message, '发不回来'));
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(marked, []);
  });
});

test('独立模式：/new 清空待结算队列，被放弃的消息不会被下一轮错认', async () => {
  await withTempDir(async (dir) => {
    const marked: string[] = [];
    const { chat } = await harness(dir.path, { markDone: (id) => marked.push(id) });

    const stale = inbound();
    await chat.handleInbound(stale, draftOf(stale, '会被放弃的'));
    const command = inbound();
    await chat.handleInbound(command, draftOf(command, '/new'));

    // 旧会话的 turn/end 因绑定已清空被丢弃；残留条目若不清，会被下一轮顶替。
    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧会话的答' }] } } });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // /new 之后的下一条会建新会话 s_2；它的回合只能结算它自己。
    const fresh = inbound();
    await chat.handleInbound(fresh, draftOf(fresh, '新会话里问'));
    chat.handleEvent('s_2', { type: 'turn/start', data: {} });
    chat.handleEvent('s_2', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } });
    chat.handleEvent('s_2', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(marked, [command.messageId, fresh.messageId]);
    assert.ok(!marked.includes(stale.messageId), '被放弃的消息不能盖完成标记');
  });
});

test('独立模式：旧版已切换但没前台记录时提示 /new，而不是让人发消息', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      dir.at('direct.json'),
      JSON.stringify({ sessionId: 's_2', workspaceId: '', title: '乙', switched: true }),
      'utf8',
    );
    const { chat, deliveries, prompts, created } = await harness(dir.path, { listRows: rowsOf() });

    const back = inbound();
    await chat.handleInbound(back, draftOf(back, '/switch 0'));
    assert.match(deliveries.at(-1)!.text, /没有前台会话记录/);
    assert.match(deliveries.at(-1)!.text, /\/new/);

    const send = inbound();
    await chat.handleInbound(send, draftOf(send, '/send 0 你好'));
    assert.match(deliveries.at(-1)!.text, /没有前台会话记录/);

    const message = inbound();
    await chat.handleInbound(message, draftOf(message, '你好'));
    assert.deepEqual(prompts.map((item) => item.sessionId), ['s_2']);
    assert.deepEqual(created, []);
  });
});

test('独立模式：当前就在前台但前台被删，/switch 0 与 /send 0 都提示 /new', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries, prompts } = await harness(dir.path, { listRows: rowsOf().slice(1) });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));

    const back = inbound();
    await chat.handleInbound(back, draftOf(back, '/switch 0'));
    assert.match(deliveries.at(-1)!.text, /不在了/);
    assert.match(deliveries.at(-1)!.text, /\/new/);

    const send = inbound();
    await chat.handleInbound(send, draftOf(send, '/send 0 你好'));
    assert.match(deliveries.at(-1)!.text, /不在了/);
    assert.equal(prompts.length, 1);
  });
});

test('独立模式：/switch 用前台 id 无需先 /sessions', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      dir.at('direct.json'),
      JSON.stringify({
        sessionId: 's_2',
        workspaceId: '',
        title: '乙',
        switched: true,
        frontSessionId: 's_1',
        frontTitle: '甲',
      }),
      'utf8',
    );
    const { chat, bindings } = await harness(dir.path, { listRows: rowsOf() });

    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch s_1'));
    const binding = await bindings.get();
    assert.equal(binding?.sessionId, 's_1');
    assert.equal(binding?.switched, undefined);
  });
});

test('独立模式：/switch 前台 id 被删时提示 /new', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      dir.at('direct.json'),
      JSON.stringify({
        sessionId: 's_2',
        workspaceId: '',
        title: '乙',
        switched: true,
        frontSessionId: 's_1',
        frontTitle: '甲',
      }),
      'utf8',
    );
    const { chat, deliveries } = await harness(dir.path, { listRows: rowsOf().slice(1) });

    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch s_1'));
    assert.match(deliveries.at(-1)!.text, /不在了/);
    assert.match(deliveries.at(-1)!.text, /\/new/);
  });
});

test('独立模式：/send 用前台 id 发到前台', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      dir.at('direct.json'),
      JSON.stringify({
        sessionId: 's_2',
        workspaceId: '',
        title: '乙',
        switched: true,
        frontSessionId: 's_1',
        frontTitle: '甲',
      }),
      'utf8',
    );
    const { chat, deliveries, prompts } = await harness(dir.path, { listRows: rowsOf() });

    const send = inbound();
    await chat.handleInbound(send, draftOf(send, '/send s_1 你好'));
    assert.equal(prompts.at(-1)!.sessionId, 's_1');
    assert.match(deliveries.at(-1)!.text, /已交给会话「甲」/);

    chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    chat.handleEvent('s_1', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '答' }] } },
    });
    chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await chat.drain();
  });
});

test('独立模式：已在前台时 /switch 0 不重复切换', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries, bindings } = await harness(dir.path, { listRows: rowsOf() });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));

    const back = inbound();
    await chat.handleInbound(back, draftOf(back, '/switch 0'));
    assert.match(deliveries.at(-1)!.text, /已经在前台会话/);
    const binding = await bindings.get();
    assert.equal(binding?.sessionId, 's_1');
    assert.equal(binding?.switched, undefined);
  });
});

test('独立模式：/switch 期间前台改名不被旧快照覆盖', async () => {
  await withTempDir(async (dir) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const listStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let gateNextList = false;
    const { chat, bindings } = await harness(dir.path, {
      listRows: rowsOf(),
      controller: {
        async list() {
          if (gateNextList) {
            gateNextList = false;
            started();
            await gate;
          }
          return { items: rowsOf() as never };
        },
      },
    });

    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));

    const sw = inbound();
    gateNextList = true;
    const switching = chat.handleInbound(sw, draftOf(sw, '/switch 1'));
    await listStarted;
    chat.handleEvent('s_1', { type: 'session/title', data: { title: '新前台' } });
    await chat.drain();
    release();
    await switching;

    const binding = await bindings.get();
    assert.equal(binding?.sessionId, 's_2');
    assert.equal(binding?.frontTitle, '新前台');
  });
});

test('独立模式：没有其它会话时提示 /switch 0 与 /send 0', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries } = await harness(dir.path, { listRows: [] });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));

    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    assert.match(deliveries.at(-1)!.text, /没有其它会话/);
    assert.match(deliveries.at(-1)!.text, /\/switch 0/);
    assert.match(deliveries.at(-1)!.text, /\/send 0/);
  });
});

test('独立模式：无关会话的标题事件不改绑定', async () => {
  await withTempDir(async (dir) => {
    const { chat, bindings } = await harness(dir.path);
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    const before = await bindings.get();

    chat.handleEvent('s_9', { type: 'session/title', data: { title: '无关' } });
    await chat.drain();
    assert.deepEqual(await bindings.get(), before);
  });
});

test('独立模式：/send 0 的前台删除提示会压平标题', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      dir.at('direct.json'),
      JSON.stringify({
        sessionId: 's_2',
        workspaceId: '',
        title: '乙',
        switched: true,
        frontSessionId: 's_1',
        frontTitle: '旧\n前台',
      }),
      'utf8',
    );
    const { chat, deliveries } = await harness(dir.path, { listRows: rowsOf().slice(1) });

    const send = inbound();
    await chat.handleInbound(send, draftOf(send, '/send 0 你好'));
    assert.match(deliveries.at(-1)!.text, /旧 前台/);
    assert.doesNotMatch(deliveries.at(-1)!.text, /旧\n前台/);
  });
});

test('独立模式：/sessions 没有会话时提示先建会话', async () => {
  await withTempDir(async (dir) => {
    const { chat, deliveries } = await harness(dir.path, { listRows: [] });
    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    assert.match(deliveries.at(-1)!.text, /还没有前台会话/);
    assert.doesNotMatch(deliveries.at(-1)!.text, /\/switch 0/);
  });
});

test('独立模式：/switch 前台短 id 被删时提示 /new', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      dir.at('direct.json'),
      JSON.stringify({
        sessionId: 's_2',
        workspaceId: '',
        title: '乙',
        switched: true,
        frontSessionId: 'session-abcdef1234',
        frontTitle: '甲',
      }),
      'utf8',
    );
    const { chat, deliveries } = await harness(dir.path, { listRows: rowsOf().slice(1) });

    const sw = inbound();
    await chat.handleInbound(sw, draftOf(sw, '/switch abcdef12'));
    assert.match(deliveries.at(-1)!.text, /不在了/);
    assert.match(deliveries.at(-1)!.text, /\/new/);
  });
});

test('独立模式：旧版无前台记录且没有其它会话时，/sessions 提示 /new', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      dir.at('direct.json'),
      JSON.stringify({ sessionId: 's_2', workspaceId: '', title: '乙', switched: true }),
      'utf8',
    );
    const { chat, deliveries } = await harness(dir.path, { listRows: [] });

    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    assert.match(deliveries.at(-1)!.text, /没有前台会话记录/);
    assert.match(deliveries.at(-1)!.text, /\/new/);
    assert.doesNotMatch(deliveries.at(-1)!.text, /\/switch 0/);
  });
});

test('独立模式：无关会话的标题事件在入队前被丢弃', async () => {
  class CountingBindings extends DirectBindingStore {
    readonly titles: Array<string | undefined> = [];
    override async setTitle(title: string, sessionId?: string): Promise<void> {
      this.titles.push(sessionId);
      await super.setTitle(title, sessionId);
    }
  }

  await withTempDir(async (dir) => {
    const bindings = new CountingBindings({ dataDir: dir.path });
    const { chat } = await harness(dir.path, { bindings, listRows: rowsOf() });
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));
    bindings.titles.length = 0;

    chat.handleEvent('s_9', { type: 'session/title', data: { title: '无关' } });
    await chat.drain();
    assert.deepEqual(bindings.titles, []);

    chat.handleEvent('s_1', { type: 'session/title', data: { title: '前台新名' } });
    await chat.drain();
    assert.deepEqual(bindings.titles, ['s_1']);
  });
});
