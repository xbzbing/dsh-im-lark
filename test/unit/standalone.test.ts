import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultSettings, normalizePluginConfig } from '../../src/host/config.ts';
import type { LocalSettings } from '../../src/host/config.ts';
import type { LarkInboundMessage } from '../../src/host/lark/types.ts';
import type { OutboundChannel, OutboundInput } from '../../src/host/outbound.ts';
import type { OwnerMessageDraft } from '../../src/host/protocol.ts';
import { StandaloneChat, buildContent, formatDuration, parseCommand } from '../../src/host/standalone.ts';
import type { StandaloneController } from '../../src/host/standalone.ts';
import { DirectBindingStore, OwnerStore } from '../../src/host/state/direct.ts';
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
}

async function harness(
  dir: string,
  options: {
    settings?: Partial<LocalSettings>;
    controller?: Partial<StandaloneController> | null;
    listRows?: Array<Record<string, unknown>>;
    workspaceId?: () => string;
    markDone?: (platformMessageId: string) => void;
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

  const bindings = new DirectBindingStore({ dataDir: dir });
  const owners = new OwnerStore({ dataDir: dir });

  const chat = new StandaloneChat({
    outbound,
    bindings,
    owners,
    settings: () => settingsOf(options.settings),
    controller: () => controller,
    workspaceId: options.workspaceId,
    ownerLabel: () => 'abcdef',
    now: () => 1_000,
    ...(options.markDone === undefined ? {} : { markDone: options.markDone }),
  });

  return { chat, deliveries, prompts, created, createArgs, cancelled, bindings, owners };
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
  assert.deepEqual(parseCommand('/send 你好 世界'), { kind: 'send', text: '你好 世界' });
  assert.deepEqual(parseCommand('/send'), { kind: 'help' });
  assert.deepEqual(parseCommand('/sessions'), { kind: 'sessions' });
  assert.deepEqual(parseCommand('/sessions 3'), { kind: 'sessions', index: 3 });
  assert.deepEqual(parseCommand('/sessions abc'), { kind: 'sessions' });
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

test('独立模式：/stop 调宿主 cancel；/send 只发文本', async () => {
  await withTempDir(async (dir) => {
    const { chat, cancelled, prompts, deliveries } = await harness(dir.path);
    const bind = inbound();
    await chat.handleInbound(bind, draftOf(bind, '建会话'));

    const stop = inbound();
    await chat.handleInbound(stop, draftOf(stop, '/stop'));
    assert.deepEqual(cancelled, ['s_1']);

    const send = inbound();
    await chat.handleInbound(send, draftOf(send, '/send 直接发送'));
    assert.equal(deliveries.at(-1)!.text, '直接发送');
    assert.equal(prompts.length, 1, '命令不进模型');
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

test('独立模式：/sessions 列出最近会话，带序号切换', async () => {
  await withTempDir(async (dir) => {
    const rows = [
      { sessionId: 's_a', projections: { values: { title: '甲' } } },
      { sessionId: 's_b', projections: { values: { title: '乙' } } },
    ];
    const { chat, deliveries, bindings } = await harness(dir.path, { listRows: rows });

    // 先认主人（sessions 命令需要主人身份）。
    const hello = inbound();
    await chat.handleInbound(hello, draftOf(hello, '你好'));

    const list = inbound();
    await chat.handleInbound(list, draftOf(list, '/sessions'));
    assert.match(deliveries.at(-1)!.text, /1\. 甲/);
    assert.match(deliveries.at(-1)!.text, /2\. 乙/);

    const switchTo = inbound();
    await chat.handleInbound(switchTo, draftOf(switchTo, '/sessions 2'));
    assert.equal((await bindings.get())?.sessionId, 's_b');
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
