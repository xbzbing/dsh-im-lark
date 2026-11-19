import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBridgeConformance } from 'dsh-my-superagent/protocol/conformance';
import type { ConformanceHarness, NativeOperation } from 'dsh-my-superagent/protocol/conformance';

import { createLarkBridge } from '../../src/host/bridge.ts';
import type { LarkApi } from '../../src/host/lark/api.ts';
import type { BridgeHandle, BridgeProvider, Delivery, InteractionAnswerDraft, OwnerMessageDraft } from '../../src/host/protocol.ts';

interface Fixture {
  provider: BridgeProvider;
  operations: () => readonly NativeOperation[];
  bridge: ReturnType<typeof createLarkBridge>;
  patches: unknown[];
  api: LarkApi;
  sentChatIds: string[];
  attach(handle: BridgeHandle): void;
  setReply(messageId: string): void;
}

/**
 * 造一套记录平台操作的假环境。
 *
 * `operations()` 需要在调用发生的那一刻知道「这条操作属于哪次交付」，所以
 * 这里包一层 `deliver`：调用期间把当前交付记下来，假 API 据此标注。
 */
function fixture(options: { maxText?: number; chatFor?: (sender: string) => string | undefined } = {}): Fixture {
  const operations: NativeOperation[] = [];
  const patches: unknown[] = [];
  const sentChatIds: string[] = [];
  let current: Delivery | null = null;
  let sequence = 0;

  const api: LarkApi = {
    async createMessage(input) {
      sequence += 1;
      sentChatIds.push(input.chatId);
      operations.push({ kind: 'send', deliveryId: current?.id ?? '', ...(current?.stream === undefined ? {} : { streamId: current.stream.id }) });
      assert.equal(input.msgType, 'interactive');
      return { messageId: `om_${sequence}` };
    },
    async replyMessage(input) {
      sequence += 1;
      operations.push({ kind: 'send', deliveryId: current?.id ?? '', ...(current?.stream === undefined ? {} : { streamId: current.stream.id }) });
      assert.equal(input.messageId, 'om_known');
      return { messageId: `om_${sequence}` };
    },
    async patchCard(input) {
      operations.push({ kind: 'edit', deliveryId: current?.id ?? '', ...(current?.stream === undefined ? {} : { streamId: current.stream.id }) });
      patches.push(input.card);
    },
    async recallMessage() {},
    async addReaction() {
      return { reactionId: 're_1' };
    },
    async removeReaction() {},
    async uploadImage() {
      return { imageKey: 'img_1' };
    },
    async uploadFile() {
      return { fileKey: 'file_1' };
    },
    async downloadResource() {
      return { bytes: new Uint8Array() };
    },
  };

  const bridge = createLarkBridge({
    account: 'cli_test',
    api,
    maxText: options.maxText ?? 2000,
    ...(options.chatFor === undefined ? {} : { chatFor: options.chatFor }),
  });

  const provider: BridgeProvider = {
    platform: bridge.provider.platform,
    account: bridge.provider.account,
    protocol: bridge.provider.protocol,
    capabilities: bridge.provider.capabilities,
    health: () => bridge.provider.health(),
    deliver: async (delivery: Delivery) => {
      current = delivery;
      try {
        return await bridge.provider.deliver(delivery);
      } finally {
        current = null;
      }
    },
  };

  return {
    provider,
    operations: () => operations,
    bridge,
    patches,
    api,
    sentChatIds,
    attach: (handle) => bridge.attach(handle),
    setReply: (messageId) => {
      void bridge.receive({
        messageId: `oc_chat:${messageId}`,
        sender: 'ou_owner',
        chatId: 'oc_chat',
        platformMessageId: messageId,
        text: '这条会被引用',
        at: 1,
      });
    },
  };
}

/** 核心侧的最小句柄：记录收到的消息与作答。 */
function coreHandle() {
  const messages: OwnerMessageDraft[] = [];
  const answers: InteractionAnswerDraft[] = [];
  let disposed = 0;

  const handle: BridgeHandle = {
    id: 'lark:cli_test',
    protocol: 'my-superagent/v1',
    async receive(message) {
      messages.push(message);
      return { accepted: true };
    },
    async answer(answer) {
      answers.push(answer);
      return { accepted: true };
    },
    update() {},
    commands: () => [],
    isOwner: () => true,
    dispose() {
      disposed += 1;
    },
  };

  return { handle, messages, answers, disposed: () => disposed };
}

const DELIVERY: Delivery = {
  protocol: 'my-superagent/v1',
  id: 'dlv_1',
  recipient: 'oc_chat',
  intent: 'result',
  title: '回答',
  body: '这是正文',
};

test('桥：能力声明能被核心的 Schema 接受', () => {
  const { provider } = fixture();
  assert.equal(provider.platform, 'lark');
  assert.match(provider.account, /^[\w.@-]{1,128}$/);
  assert.equal(provider.health().state, 'ok');
});

test('桥：交付成功时回执带平台消息 id 与条数', async () => {
  const { provider } = fixture();
  const receipt = await provider.deliver(DELIVERY);

  assert.equal(receipt.deliveryId, 'dlv_1');
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.bridgeMessageId, 'om_1');
  assert.deepEqual(receipt.bridgeMessageIds, ['om_1']);
  assert.equal(receipt.messagesSent, 1);
});

test('桥：过期交付不产生平台调用', async () => {
  const { provider, operations } = fixture();
  const receipt = await provider.deliver({ ...DELIVERY, expiresAt: 1 });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.errorCode, 'window-closed');
  assert.equal(operations().length, 0);
});

test('桥：只有引用过我们收到的消息时才用 reply', async () => {
  const { provider, operations, setReply } = fixture();

  // 核心回引用的是桥自己的 messageId，不是平台 id。
  await provider.deliver({ ...DELIVERY, id: 'dlv_unknown', inReplyTo: 'oc_chat:om_unknown' });
  // 未知消息 id 交给 reply 会被平台拒，退回群发。
  assert.equal(operations().length, 1);

  setReply('om_known');
  await provider.deliver({ ...DELIVERY, id: 'dlv_known', inReplyTo: 'oc_chat:om_known' });
  assert.equal(operations().length, 2);
});

test('桥：核心用 open_id 当收件人时翻译成会话 id', async () => {
  const { provider, bridge, sentChatIds } = fixture();
  await bridge.receive({
    messageId: 'oc_chat:om_1',
    sender: 'ou_owner',
    chatId: 'oc_chat',
    platformMessageId: 'om_1',
    text: '你好',
    at: 1,
  });

  const receipt = await provider.deliver({ ...DELIVERY, recipient: 'ou_owner' });
  assert.equal(receipt.status, 'sent');
  assert.deepEqual(sentChatIds, ['oc_chat']);
});

test('桥：收件人没有会话映射时不发消息并回失败', async () => {
  const { provider, operations } = fixture();
  const receipt = await provider.deliver({ ...DELIVERY, recipient: 'ou_stranger' });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.errorCode, 'other');
  assert.equal(operations().length, 0);
});

test('桥：重启后还没收到消息时，从本机 owner 映射找回会话', async () => {
  const { provider, sentChatIds } = fixture({
    chatFor: (sender) => (sender === 'ou_owner' ? 'oc_seed' : undefined),
  });
  const receipt = await provider.deliver({ ...DELIVERY, recipient: 'ou_owner' });

  assert.equal(receipt.status, 'sent');
  assert.deepEqual(sentChatIds, ['oc_seed']);
});

test('桥：多问题交互不登记（IM 无法一次答完，交回 Web）', async () => {
  const { provider, bridge } = fixture();
  const core = coreHandle();
  bridge.attach(core.handle);

  const receipt = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_multi',
    intent: 'action',
    interaction: {
      questions: [
        { id: 'q1', question: '甲？', options: [{ label: '一' }] },
        { id: 'q2', question: '乙？', options: [{ label: '二' }] },
      ],
    },
  });

  assert.equal(receipt.status, 'sent');
  assert.equal(bridge.interactions.size, 0);
});

test('桥：流式修订原地更新，迟到修订不产生操作', async () => {
  const { provider, operations } = fixture();
  const stream = { id: 's_1', revision: 1, final: false };

  await provider.deliver({ ...DELIVERY, id: 'dlv_s1', intent: 'progress', body: 'r1', stream });
  await provider.deliver({ ...DELIVERY, id: 'dlv_s2', intent: 'progress', body: 'r2', stream: { ...stream, revision: 2 } });
  const before = operations().length;
  const stale = await provider.deliver({ ...DELIVERY, id: 'dlv_s3', intent: 'progress', body: 'r0', stream: { ...stream, revision: 1 } });

  assert.equal(stale.status, 'sent');
  assert.equal(stale.messagesSent, 0);
  assert.equal(operations().length, before);
  assert.equal(operations().filter((op) => op.kind === 'edit').length, 1);
});

test('桥：流式卡片超限只分条发一次，后续修订不刷屏', async () => {
  const { provider, operations } = fixture();
  const body = 'a'.repeat(30_000);
  const stream = { id: 'big', revision: 1, final: false };

  const first = await provider.deliver({ ...DELIVERY, id: 'dlv_big1', intent: 'progress', body, stream });
  assert.equal(first.status, 'sent');
  const sent = operations().length;
  assert.ok(sent > 1, '超长内容应分条发送');

  const second = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_big2',
    intent: 'progress',
    body,
    stream: { ...stream, revision: 2 },
  });
  assert.equal(second.messagesSent, 0);
  assert.equal(operations().length, sent);
});

test('桥：supersedes 把旧卡改成终态', async () => {
  const { provider, patches } = fixture();
  await provider.deliver({ ...DELIVERY, id: 'dlv_old' });
  await provider.deliver({ ...DELIVERY, id: 'dlv_new', supersedes: 'dlv_old' });

  assert.equal(patches.length, 1);
  assert.match(JSON.stringify(patches[0]), /已被新卡片替代/);
});

test('桥：交互交付登记待作答，作答后改写终态卡', async () => {
  const { provider, bridge, patches } = fixture();
  const core = coreHandle();
  bridge.attach(core.handle);

  const delivery: Delivery = {
    ...DELIVERY,
    id: 'dlv_ask',
    intent: 'action',
    interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }] },
  };
  const receipt = await provider.deliver(delivery);
  assert.equal(receipt.status, 'sent');
  assert.equal(bridge.interactions.size, 1);

  const result = await bridge.applyCardAction({
    eventId: 'ev_1',
    messageId: 'om_1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_owner',
    value: { d: 'dlv_ask', q: 'q1', o: 1 },
  });

  assert.deepEqual(result, { accepted: true });
  assert.equal(core.answers.length, 1);
  assert.deepEqual(core.answers[0]!.answers, [{ id: 'q1', selected: ['乙'] }]);
  assert.equal(bridge.interactions.get('dlv_ask')?.answered, true);

  // 终态改写是异步的，等一个 tick 再断言。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(patches.length, 1);
  assert.match(JSON.stringify(patches[0]), /已作答/);
});

test('桥：审批类问题不允许在 IM 作答', async () => {
  const { provider, bridge } = fixture();
  const core = coreHandle();
  bridge.attach(core.handle);

  await provider.deliver({
    ...DELIVERY,
    id: 'dlv_approve',
    intent: 'action',
    interaction: {
      questions: [{ id: 'q1', question: '是否合并', intent: 'approval', options: [{ label: '同意' }, { label: '拒绝' }] }],
    },
  });

  const result = await bridge.applyCardAction({
    eventId: 'ev_2',
    messageId: 'om_1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_owner',
    value: { d: 'dlv_approve', q: 'q1', o: 0 },
  });

  assert.equal(result.accepted, false);
  if (!result.accepted) assert.equal(result.reason, 'not-allowed');
  assert.equal(core.answers.length, 0);
});

test('桥：未接入核心时接收与作答都回 unknown', async () => {
  const { bridge } = fixture();
  const received = await bridge.receive({ messageId: 'm', sender: 'ou', text: 'hi', at: 1 });
  const answered = await bridge.answer({ deliveryId: 'd', sender: 'ou', answers: [{ id: 'q', selected: [] }], at: 1 });

  assert.equal(received.accepted, false);
  assert.equal(answered.accepted, false);
  if (!received.accepted) assert.equal(received.reason, 'unknown');
});

test('桥：attach 后把能力交给核心，detach 时释放句柄', () => {
  const { bridge } = fixture();
  const core = coreHandle();
  bridge.attach(core.handle);
  bridge.detach();
  assert.equal(core.disposed(), 1);
});

test('桥：已销毁的桥拒绝交付', async () => {
  const { bridge, provider } = fixture();
  bridge.dispose();
  const receipt = await provider.deliver({ ...DELIVERY, id: 'dlv_after_dispose' });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.errorCode, 'other');
});

/* --------------------------------------------------------- 一致性测试（核心提供） */

runBridgeConformance('飞书桥', {
  recipient: 'oc_conformance',
  create: () => {
    const { provider, operations, bridge } = fixture();
    return {
      // 核心类型与本仓库的最小结构类型是两份声明，形状一致；在测试边界桥接一次。
      provider: provider as unknown as ConformanceHarness['provider'],
      operations: () => operations(),
      dispose: () => bridge.dispose(),
    };
  },
});
