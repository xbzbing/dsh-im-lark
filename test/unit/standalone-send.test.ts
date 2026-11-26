import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultSettings, normalizePluginConfig } from '../../src/host/config.ts';
import type { LarkInboundMessage } from '../../src/host/lark/types.ts';
import type { OutboundChannel, OutboundInput } from '../../src/host/outbound.ts';
import type { OwnerMessageDraft } from '../../src/host/protocol.ts';
import { StandaloneChat } from '../../src/host/standalone.ts';
import type { StandaloneController } from '../../src/host/standalone.ts';
import { DirectBindingStore, OwnerStore } from '../../src/host/state/direct.ts';
import { ListingStore } from '../../src/host/state/listing.ts';
import { withTempDir } from './helpers/temp.ts';

interface SendHarness {
  chat: StandaloneChat;
  deliveries: OutboundInput[];
  prompts: Array<{ sessionId: string; mode: string; content: unknown[] }>;
  marked: string[];
  bindings: DirectBindingStore;
  listing: ListingStore;
  timers: Array<() => void>;
}

async function harness(
  dir: string,
  options: {
    rows?: Array<Record<string, unknown>>;
    sendTimeoutMs?: number;
    listing?: ListingStore;
  } = {},
): Promise<SendHarness> {
  const deliveries: OutboundInput[] = [];
  const prompts: SendHarness['prompts'] = [];
  const marked: string[] = [];
  const timers: Array<() => void> = [];

  const outbound = {
    async deliver(input: OutboundInput) {
      deliveries.push(input);
      return { messageIds: [`om_${deliveries.length}`], messagesSent: 1 };
    },
  } as unknown as OutboundChannel;

  let count = 0;
  const controller: StandaloneController = {
    async create() {
      count += 1;
      return { sessionId: `s_${count}` };
    },
    async prompt(request) {
      prompts.push({ sessionId: request.sessionId, mode: request.mode, content: [...request.content] });
      return { accepted: true };
    },
    cancel() {
      return { accepted: true };
    },
    async list() {
      return { items: (options.rows ?? []) as never };
    },
    async rename() {},
  };

  const bindings = new DirectBindingStore({ dataDir: dir });
  const owners = new OwnerStore({ dataDir: dir });
  const listing = options.listing ?? new ListingStore({ dataDir: dir });

  const chat = new StandaloneChat({
    outbound,
    bindings,
    owners,
    listing,
    settings: () => defaultSettings(normalizePluginConfig({})),
    controller: () => controller,
    ownerLabel: () => 'abcdef',
    now: () => 1_000,
    markDone: (id) => marked.push(id),
    ...(options.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: options.sendTimeoutMs }),
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => {},
  });

  return { chat, deliveries, prompts, marked, bindings, listing, timers };
}

let sequence = 0;
function inbound(): LarkInboundMessage {
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

const ROWS = [
  { sessionId: 's_1', projections: { values: { title: '甲' } } },
  { sessionId: 's_2', projections: { values: { title: '乙' } } },
];

/** 先认主人并建绑定会话，再列一次会话快照。 */
async function bindAndList(h: SendHarness): Promise<void> {
  const hello = inbound();
  await h.chat.handleInbound(hello, draftOf(hello, '你好'));
  const list = inbound();
  await h.chat.handleInbound(list, draftOf(list, '/sessions'));
}

test('/send 按序号发到目标会话，回答回到发命令的聊天', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, { rows: ROWS });
    await bindAndList(h);

    const send = inbound();
    await h.chat.handleInbound(send, draftOf(send, '/send 1 帮我看看'));
    assert.equal(h.prompts.at(-1)!.sessionId, 's_2');
    assert.equal(h.prompts.at(-1)!.mode, 'queue');
    assert.match(h.deliveries.at(-1)!.text, /已交给会话「乙」/);
    assert.equal((await h.bindings.get())?.sessionId, 's_1', '不切换绑定');
    assert.ok(!h.marked.includes(send.messageId), '回答没回来之前不打 DONE');

    h.chat.handleEvent('s_2', { type: 'turn/start', data: {} });
    h.chat.handleEvent('s_2', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '乙的答' }] } } });
    h.chat.handleEvent('s_2', { type: 'turn/end', data: {} });
    await h.chat.drain();

    const answer = h.deliveries.at(-1)!;
    assert.match(answer.text, /来自会话「乙」/);
    assert.match(answer.text, /乙的答/);
    assert.equal(answer.replyTo, send.messageId);
    assert.ok(h.marked.includes(send.messageId));
  });
});

test('/send 到当前会话走普通提交，回答只发一次', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, { rows: ROWS });
    await bindAndList(h);

    const send = inbound();
    await h.chat.handleInbound(send, draftOf(send, '/send 0 继续'));
    assert.equal(h.prompts.at(-1)!.sessionId, 's_1');
    assert.match(h.deliveries.at(-1)!.text, /当前会话/);

    h.chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    h.chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '继续的答' }] } } });
    h.chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(h.deliveries.at(-1)!.text, /继续的答/);
    assert.equal(h.deliveries.filter((item) => item.text.includes('来自会话')).length, 0);
    assert.ok(h.marked.includes(send.messageId));
  });
});

test('/send 0 从其它会话发到前台，回答回到这里', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, { rows: ROWS });
    await bindAndList(h);

    const sw = inbound();
    await h.chat.handleInbound(sw, draftOf(sw, '/switch 1'));
    const send = inbound();
    await h.chat.handleInbound(send, draftOf(send, '/send 0 回前台'));
    assert.equal(h.prompts.at(-1)!.sessionId, 's_1');

    h.chat.handleEvent('s_1', { type: 'turn/start', data: {} });
    h.chat.handleEvent('s_1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '前台答' }] } } });
    h.chat.handleEvent('s_1', { type: 'turn/end', data: {} });
    await h.chat.drain();

    assert.match(h.deliveries.at(-1)!.text, /来自会话「甲」/);
    assert.match(h.deliveries.at(-1)!.text, /前台答/);
    assert.equal((await h.bindings.get())?.sessionId, 's_2');
  });
});

test('/send 的序号不在快照里时提示先列会话', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, { rows: ROWS });
    const hello = inbound();
    await h.chat.handleInbound(hello, draftOf(hello, '你好'));

    const missing = inbound();
    await h.chat.handleInbound(missing, draftOf(missing, '/send 1 你好'));
    assert.match(h.deliveries.at(-1)!.text, /还没列过会话/);
    assert.equal(h.prompts.length, 1);

    const list = inbound();
    await h.chat.handleInbound(list, draftOf(list, '/sessions'));
    const outOfRange = inbound();
    await h.chat.handleInbound(outOfRange, draftOf(outOfRange, '/send 9 你好'));
    assert.match(h.deliveries.at(-1)!.text, /序号 9 不在/);
    assert.equal(h.prompts.length, 1);
  });
});

test('/send 排队时跳过目标会话上一轮的 turn/end', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, {
      rows: [
        { sessionId: 's_1', projections: { values: { title: '甲' } } },
        { sessionId: 's_2', projections: { values: { title: '乙' } }, running: true },
      ],
    });
    await bindAndList(h);

    const send = inbound();
    await h.chat.handleInbound(send, draftOf(send, '/send 1 排队'));
    assert.match(h.deliveries.at(-1)!.text, /正在运行/);

    // 先到的是上一轮的收尾，不能当成这一轮的回答。
    h.chat.handleEvent('s_2', { type: 'turn/end', data: {} });
    await h.chat.drain();
    assert.equal(h.deliveries.filter((item) => item.text.includes('来自会话')).length, 0);

    h.chat.handleEvent('s_2', { type: 'turn/start', data: {} });
    h.chat.handleEvent('s_2', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答' }] } } });
    h.chat.handleEvent('s_2', { type: 'turn/end', data: {} });
    await h.chat.drain();

    const answers = h.deliveries.filter((item) => item.text.includes('来自会话'));
    assert.equal(answers.length, 1);
    assert.match(answers[0]!.text, /答/);
  });
});

test('/send 超时后不再等，且不打 DONE', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, { rows: ROWS, sendTimeoutMs: 60_000 });
    await bindAndList(h);

    const send = inbound();
    await h.chat.handleInbound(send, draftOf(send, '/send 1 内容'));
    assert.equal(h.timers.length, 1);

    h.timers[0]!();
    await h.chat.drain();
    assert.match(h.deliveries.at(-1)!.text, /没有在 1 分钟内结束/);
    assert.ok(!h.marked.includes(send.messageId));
  });
});

test('/send 的序号快照跨重启保留', async () => {
  await withTempDir(async (dir) => {
    const first = await harness(dir.path, { rows: ROWS });
    await bindAndList(first);
    first.chat.stop();

    const second = await harness(dir.path, { rows: ROWS });
    const send = inbound();
    await second.chat.handleInbound(send, draftOf(send, '/send 1 重启后'));
    assert.equal(second.prompts.at(-1)!.sessionId, 's_2');
    second.chat.stop();
  });
});

test('/send 的回合被中止时只回提示，不打 DONE', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, { rows: ROWS });
    await bindAndList(h);

    const send = inbound();
    await h.chat.handleInbound(send, draftOf(send, '/send 1 内容'));
    h.chat.handleEvent('s_2', { type: 'turn/start', data: {} });
    h.chat.handleEvent('s_2', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '半截' }] } } });
    h.chat.handleEvent('s_2', { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
    await h.chat.drain();

    assert.match(h.deliveries.at(-1)!.text, /被中止了/);
    assert.ok(!h.marked.includes(send.messageId));
  });
});

test('/send 只附图也能发到目标会话', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, { rows: ROWS });
    await bindAndList(h);

    const send = inbound();
    await h.chat.handleInbound(send, draftOf(send, '/send 1', {
      images: [{ mediaType: 'image/png', data: 'AAAA', name: '图.png' }],
    }));

    assert.equal(h.prompts.at(-1)!.sessionId, 's_2');
    const content = h.prompts.at(-1)!.content as Array<Record<string, unknown>>;
    assert.deepEqual(content[0], { type: 'image', mediaType: 'image/png', data: 'AAAA', name: '图.png' });
  });
});

test('/send 的回合失败时回错误原文，不打 DONE', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, { rows: ROWS });
    await bindAndList(h);

    const send = inbound();
    await h.chat.handleInbound(send, draftOf(send, '/send 1 内容'));
    h.chat.handleEvent('s_2', { type: 'turn/start', data: {} });
    h.chat.handleEvent('s_2', { type: 'turn/end', data: { reason: { kind: 'failed', error: { message: '模型炸了' } } } });
    await h.chat.drain();

    assert.match(h.deliveries.at(-1)!.text, /这一轮失败：模型炸了/);
    assert.ok(!h.marked.includes(send.messageId));
  });
});

test('/send 的回合没有文本时只提示，不打 DONE', async () => {
  await withTempDir(async (dir) => {
    const h = await harness(dir.path, { rows: ROWS });
    await bindAndList(h);

    const send = inbound();
    await h.chat.handleInbound(send, draftOf(send, '/send 1 内容'));
    h.chat.handleEvent('s_2', { type: 'turn/start', data: {} });
    h.chat.handleEvent('s_2', { type: 'turn/end', data: {} });
    await h.chat.drain();

    assert.match(h.deliveries.at(-1)!.text, /没有可发送的文本/);
    assert.ok(!h.marked.includes(send.messageId));
  });
});
