import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLarkBridge } from '../../src/host/bridge.ts';
import type { LarkApi } from '../../src/host/lark/api.ts';
import type { AcceptResult, BridgeHandle, BridgeProvider, Delivery, InteractionAnswerDraft, OwnerMessageDraft } from '../../src/host/protocol.ts';

/** 桥对平台发出的操作：契约用例据此判断「有没有真的再发一次」。 */
interface NativeOperation {
  kind: 'send' | 'edit';
  deliveryId: string;
  streamId?: string;
}

interface Fixture {
  provider: BridgeProvider;
  operations: () => readonly NativeOperation[];
  bridge: ReturnType<typeof createLarkBridge>;
  patches: unknown[];
  api: LarkApi;
  sentChatIds: string[];
  contents: string[];
  attach(handle: BridgeHandle): void;
  setReply(messageId: string): void;
}

/**
 * 造一套记录平台操作的假环境。
 *
 * `operations()` 需要在调用发生的那一刻知道「这条操作属于哪次交付」，所以
 * 这里包一层 `deliver`：调用期间把当前交付记下来，假 API 据此标注。
 */
function fixture(
  options: {
    maxText?: number;
    chatFor?: (sender: string) => string | undefined;
    markDone?: (platformMessageId: string) => void;
  } = {},
): Fixture {
  const operations: NativeOperation[] = [];
  const patches: unknown[] = [];
  const sentChatIds: string[] = [];
  const contents: string[] = [];
  let current: Delivery | null = null;
  let sequence = 0;

  const api: LarkApi = {
    async createMessage(input) {
      sequence += 1;
      sentChatIds.push(input.chatId);
      contents.push(input.content);
      operations.push({ kind: 'send', deliveryId: current?.id ?? '', ...(current?.stream === undefined ? {} : { streamId: current.stream.id }) });
      assert.equal(input.msgType, 'interactive');
      return { messageId: `om_${sequence}` };
    },
    async replyMessage(input) {
      sequence += 1;
      contents.push(input.content);
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
    ...(options.markDone === undefined ? {} : { markDone: options.markDone }),
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
    contents,
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

/** 核心侧的最小句柄：记录收到的消息与作答；`answerResult` 用来模拟核心拒绝。 */
function coreHandle(options: { answerResult?: AcceptResult } = {}) {
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
      return options.answerResult ?? { accepted: true };
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

test('桥：能力声明是合法形状', () => {
  const { provider } = fixture();
  const caps = provider.capabilities;

  // 身份与协议：原核心 Schema 的本地等价物（核心仓库仍是权威定义）。
  assert.equal(provider.platform, 'lark');
  assert.match(provider.platform, /^[a-z][a-z0-9-]{0,31}$/);
  assert.match(provider.account, /^[\w.@-]{1,128}$/);
  assert.ok(provider.protocol.includes('my-superagent/v1'));
  assert.ok(['ok', 'degraded', 'down'].includes(provider.health().state));

  assert.equal(typeof caps.detail, 'boolean');
  assert.equal(typeof caps.nativeCommands, 'boolean');
  assert.ok(['none', 'basic', 'full'].includes(caps.markdown));
  assert.ok(Number.isInteger(caps.maxText.max) && caps.maxText.max > 0);
  assert.ok(['char', 'utf8-byte'].includes(caps.maxText.unit));
  assert.equal(typeof caps.outbound.requiresPriorInbound, 'boolean');

  if (caps.interaction !== undefined) {
    assert.equal(typeof caps.interaction.choice, 'boolean');
    assert.equal(typeof caps.interaction.multiChoice, 'boolean');
    assert.equal(typeof caps.interaction.freeText, 'boolean');
    assert.ok(Number.isInteger(caps.interaction.maxOptions) && caps.interaction.maxOptions > 0);
    assert.ok(Number.isInteger(caps.interaction.maxQuestions) && caps.interaction.maxQuestions > 0);
    assert.ok(['any', 'immediate', 'none'].includes(caps.interaction.updateAfterAnswer));
  }
  if (caps.edit !== undefined) {
    assert.ok(['any', 'reply'].includes(caps.edit.scope));
    assert.ok(caps.edit.minIntervalMs >= 0);
  }
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

/* ---------------------------------------------------------- 协议契约（本地自测） */

/**
 * 这套以前调用私有核心导出的 `runBridgeConformance`（devDependency 指向
 * `file:../dsh-my-superagent`）。公开仓库不该为测试拉一个私有包，所以把核心那套
 * 契约里与本仓库相关、且原有用例没覆盖的部分在本地重写：
 *
 * - 身份与能力形状：见上面「能力声明是合法形状」；
 * - 迟到修订不回退、卡片超限只分条一次：见上面两条流式用例；
 * - 这里补「同一交付 id 只发一次」与「超长正文分条送达」。
 *
 * 权威 Schema 仍在核心仓库；形状变了由 `src/host/protocol.ts` 的边界类型先报错。
 */
test('契约：同一交付 id 只发一次', async () => {
  const { provider, operations } = fixture();
  const first = await provider.deliver({ ...DELIVERY, id: 'dlv_contract_once' });
  const before = operations().length;
  const again = await provider.deliver({ ...DELIVERY, id: 'dlv_contract_once' });

  assert.equal(first.status, 'sent');
  assert.equal(again.status, 'sent');
  assert.equal(operations().length, before, '同 id 重投不应产生新的平台操作');
  assert.equal(again.bridgeMessageId, first.bridgeMessageId);
});

test('契约：超长正文照样送达', async () => {
  const { provider } = fixture();
  const max = provider.capabilities.maxText.max;
  const receipt = await provider.deliver({ ...DELIVERY, id: 'dlv_contract_long', body: '长'.repeat(max + 100) });

  // 卡片能装下就一张卡发完（平台限制按卡片体积算，不是 maxText）；装不下走文本分条。
  assert.equal(receipt.status, 'sent');
  assert.ok((receipt.messagesSent ?? 0) >= 1);
});

/* ------------------------------------------------------------------ 作答被拒的反馈 */

const ASK: Delivery = {
  ...DELIVERY,
  id: 'dlv_ask2',
  intent: 'action',
  interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }] },
};

test('桥：核心拒绝作答时重画同一张卡并写清原因', async () => {
  const { provider, bridge, patches, contents } = fixture();
  const core = coreHandle({ answerResult: { accepted: false, reason: 'invalid-answer' } });
  bridge.attach(core.handle);

  await provider.deliver(ASK);

  const result = await bridge.applyCardAction({
    eventId: 'ev_reject',
    messageId: 'om_1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_owner',
    value: { d: 'dlv_ask2', q: 'q1', o: 0 },
  });

  assert.equal(result.accepted, false);
  if (!result.accepted) assert.equal(result.reason, 'invalid-answer');
  // 表单提交是一次性的：只发提示会让卡点不动，所以必须整卡重画，勾选框还在。
  assert.equal(patches.length, 1);
  assert.match(JSON.stringify(patches[0]), /单选题只能勾一项/u);
  assert.match(JSON.stringify(patches[0]), /"tag":"form"/u);
  assert.match(JSON.stringify(patches[0]), /"tag":"checker"/u);
  // 没有再发一条消息：说明就写在这张卡上。
  assert.equal(contents.length, 1);
  // 卡还能答：这次拒绝不该把待作答标记成「已作答」。
  assert.equal(bridge.interactions.get('dlv_ask2')?.answered, false);
});

test('桥：卡已失效时改成失效态，去掉勾选框只留说明', async () => {
  const { provider, bridge, patches, contents } = fixture();
  const core = coreHandle({ answerResult: { accepted: false, reason: 'expired' } });
  bridge.attach(core.handle);

  await provider.deliver(ASK);

  const result = await bridge.applyCardAction({
    eventId: 'ev_expired',
    messageId: 'om_1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_owner',
    value: { d: 'dlv_ask2', q: 'q1', o: 0 },
  });

  assert.equal(result.accepted, false);
  assert.equal(patches.length, 1);
  assert.match(JSON.stringify(patches[0]), /这张卡已经过期/u);
  assert.doesNotMatch(JSON.stringify(patches[0]), /"tag":"checker"/u);
  assert.equal(bridge.interactions.get('dlv_ask2'), undefined);
  // 卡本身已经改成失效态，不再额外发消息。
  assert.equal(contents.length, 1);
});

test('桥：核心回「已作答」时不再提示', async () => {
  const { provider, bridge, patches, contents } = fixture();
  const core = coreHandle({ answerResult: { accepted: false, reason: 'settled' } });
  bridge.attach(core.handle);

  await provider.deliver(ASK);

  const result = await bridge.applyCardAction({
    eventId: 'ev_settled',
    messageId: 'om_1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_owner',
    value: { d: 'dlv_ask2', q: 'q1', o: 0 },
  });

  assert.equal(result.accepted, false);
  assert.equal(contents.length, 1);
  assert.equal(patches.length, 0);
});

test('桥：单选勾了多项时每次刷新卡片，改成一项即可通过', async () => {
  const { provider, bridge, patches, contents } = fixture();
  const core = coreHandle();
  bridge.attach(core.handle);

  await provider.deliver(ASK);

  const base = { messageId: 'om_1', chatId: 'oc_chat', operatorOpenId: 'ou_owner', value: { d: 'dlv_ask2', q: 'q1' } };
  const first = await bridge.applyCardAction({ ...base, eventId: 'ev_multi_1', formValues: { answer_0: true, answer_1: true } });

  assert.equal(first.accepted, false);
  if (!first.accepted) assert.equal(first.reason, 'invalid-answer');
  // 每次拒绝都重画这张卡：飞书的表单提交是一次性的，不重画就没法再提交。
  assert.equal(patches.length, 1);
  assert.match(JSON.stringify(patches[0]), /单选题只能勾一项/u);
  assert.equal(core.answers.length, 0);
  // 提示写在卡上，不额外发消息。
  assert.equal(contents.length, 1);

  const ok = await bridge.applyCardAction({ ...base, eventId: 'ev_multi_2', formValues: { answer_0: true } });
  assert.deepEqual(ok, { accepted: true });
  assert.deepEqual(core.answers[0]!.answers, [{ id: 'q1', selected: ['甲'] }]);
  assert.equal(patches.length, 2);
  assert.match(JSON.stringify(patches[1]), /已作答/u);
});

test('桥：流式终稿送达后给原消息补 DONE，进度修订不补', async () => {
  const marked: string[] = [];
  const { provider, setReply } = fixture({ markDone: (id) => marked.push(id) });
  setReply('om_known');

  const progress = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_progress',
    inReplyTo: 'oc_chat:om_known',
    stream: { id: 's1', revision: 1, final: false },
  });
  assert.equal(progress.status, 'sent');
  assert.deepEqual(marked, [], '进度修订不是完成');

  const final = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_final',
    inReplyTo: 'oc_chat:om_known',
    stream: { id: 's1', revision: 2, final: true },
  });
  assert.equal(final.status, 'sent');
  assert.deepEqual(marked, ['om_known']);
});

test('桥：非流式收尾（带会话 refs）补 DONE；分发回执、停滞与孤儿提醒不补', async () => {
  const marked: string[] = [];
  const { provider, setReply } = fixture({ markDone: (id) => marked.push(id) });
  setReply('om_known');
  const refs = [{ kind: 'session' as const, id: 's_1', title: '会话' }];

  // 核心 conversationGranularity='result' 时的非流式正常收尾：带会话 refs。
  const done = await provider.deliver({ ...DELIVERY, id: 'dlv_done', inReplyTo: 'oc_chat:om_known', refs });
  assert.equal(done.status, 'sent');
  assert.deepEqual(marked, ['om_known']);

  // 分发回执/提示：intent 也是 result、也带 inReplyTo，但没有 refs——任务还在别处跑。
  const ack = await provider.deliver({ ...DELIVERY, id: 'dlv_ack', title: '', body: '已分发', inReplyTo: 'oc_chat:om_known' });
  assert.equal(ack.status, 'sent');
  assert.deepEqual(marked, ['om_known'], '分发回执不算完成');

  // 两个带 refs 的已知非完成项按固定标题排除（停滞说任务可能还在跑，孤儿收尾说结果没送回来）。
  for (const title of ['长时间没有动静', '这一轮没有正常收尾']) {
    const notice = await provider.deliver({ ...DELIVERY, id: `dlv_${title}`, title, inReplyTo: 'oc_chat:om_known', refs });
    assert.equal(notice.status, 'sent');
  }
  assert.deepEqual(marked, ['om_known'], '停滞/孤儿提醒不算完成');
});

test('桥：发送失败或 inReplyTo 不在映射里时不补 DONE', async () => {
  const marked: string[] = [];
  const { provider, setReply } = fixture({ markDone: (id) => marked.push(id) });
  setReply('om_src');

  // 收件人翻译不出会话：交付失败，只留「收到」。
  const failed = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_fail',
    recipient: 'ou_nobody',
    inReplyTo: 'oc_chat:om_src',
    stream: { id: 's2', revision: 1, final: true },
  });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(marked, []);

  // 重启丢了入站映射：final 也找不到原消息。
  const unknown = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_unknown',
    inReplyTo: 'oc_chat:om_gone',
    stream: { id: 's3', revision: 1, final: true },
  });
  assert.equal(unknown.status, 'sent');
  assert.deepEqual(marked, []);
});
