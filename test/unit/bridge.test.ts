import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLarkBridge } from '../../src/host/bridge.ts';
import type { LarkApi } from '../../src/host/lark/api.ts';
import type { LarkLogger } from '../../src/host/lark/connection.ts';
import type {
  AcceptResult,
  BridgeHandle,
  BridgeProvider,
  Delivery,
  InteractionAnswerDraft,
  InteractionAnswerItem,
  InteractionQuestion,
  OwnerMessageDraft,
} from '../../src/host/protocol.ts';

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
    logger?: LarkLogger;
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
    ...(options.logger === undefined ? {} : { logger: options.logger }),
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

/** 假 API 记的是卡片 JSON 原文：取出其中所有 markdown 元素的文字，方便断言正文。 */
function cardText(raw: string): string {
  const card = JSON.parse(raw) as { body: { elements: Array<{ tag: string; content?: string }> } };
  return card.body.elements
    .filter((element) => element.tag === 'markdown')
    .map((element) => element.content ?? '')
    .join('\n');
}

/**
 * 本地镜像核心 `validateAnswer` 的判定：题 id 必须存在且各答一次，选中项必须是
 * 该题的选项，单选最多一项，每项至少要有非空 selected 或 custom。
 *
 * 仓库不允许依赖 `dsh-my-superagent`，这里只做契约对照；核心规则变了要同步改。
 */
function acceptableAnswer(questions: readonly InteractionQuestion[], answers: readonly InteractionAnswerItem[]): boolean {
  const seen = new Set<string>();
  for (const answer of answers) {
    if (answer.selected.length === 0 && (answer.custom ?? '').trim() === '') return false;
    const question = questions.find((candidate) => candidate.id === answer.id);
    if (question === undefined || seen.has(answer.id)) return false;
    seen.add(answer.id);
    const labels = (question.options ?? []).map((option) => option.label);
    if (answer.selected.some((label) => !labels.includes(label))) return false;
    if (question.multiSelect !== true && answer.selected.length > 1) return false;
  }
  return seen.size === questions.length;
}

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

const SESSION_REF = [{ kind: 'session' as const, id: 's_1', title: '会话一' }];

test('桥：真的发出了引用回复时，卡片不再重复「参考」段', async () => {
  const { provider, contents, setReply } = fixture();
  setReply('om_known');

  const receipt = await provider.deliver({ ...DELIVERY, id: 'dlv_quoted', inReplyTo: 'oc_chat:om_known', refs: SESSION_REF });

  assert.equal(receipt.status, 'sent');
  // 引用气泡已经定位到原消息，再列一遍会话标题只是噪音。
  assert.doesNotMatch(cardText(contents[0]!), /参考/u);
});

test('桥：没有引用回复时，卡片用「参考」段给出会话定位', async () => {
  const { provider, contents } = fixture();

  await provider.deliver({ ...DELIVERY, id: 'dlv_push', refs: SESSION_REF });

  // 主动推送（长任务、周报、分析）没有引用气泡，只能靠这段告诉用户这是哪个会话。
  assert.match(cardText(contents[0]!), /参考：\n- 会话一/u);
});

test('桥：inReplyTo 指向的消息不在内存里时仍保留「参考」段', async () => {
  const { provider, contents } = fixture();

  // 插件重启后 inbound 缓存是空的：消息带不上引用气泡，删掉「参考」就丢了唯一定位线索。
  await provider.deliver({ ...DELIVERY, id: 'dlv_lost', inReplyTo: 'oc_chat:om_lost', refs: SESSION_REF });

  assert.match(cardText(contents[0]!), /参考：\n- 会话一/u);
});

test('桥：作答后重画卡片不会把「参考」段补回来', async () => {
  const { provider, bridge, patches, setReply } = fixture();
  bridge.attach(coreHandle().handle);
  setReply('om_known');

  const receipt = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_ask',
    intent: 'action',
    inReplyTo: 'oc_chat:om_known',
    refs: SESSION_REF,
    interaction: { questions: [{ id: 'q1', question: '甲？', options: [{ label: '一' }] }] },
  });
  assert.equal(receipt.status, 'sent');

  const result = await bridge.applyCardAction({
    eventId: 'ev_ref_1',
    messageId: 'om_1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_owner',
    value: { d: 'dlv_ask' },
    formValues: { answer_0_0: true },
  });
  assert.deepEqual(result, { accepted: true });

  // 终态改写是异步 PATCH：等一轮宏任务再断言。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(patches.length, 1);
  assert.doesNotMatch(JSON.stringify(patches[0]), /参考/u);
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

test('桥：多问题交互登记为可作答，一次提交答完全部题目', async () => {
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
  assert.equal(bridge.interactions.size, 1);

  const result = await bridge.applyCardAction({
    eventId: 'ev_multi_one',
    messageId: 'om_1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_owner',
    value: { d: 'dlv_multi' },
    formValues: { answer_0_0: true, answer_1_0: true },
  });

  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(core.answers[0]!.answers, [
    { id: 'q1', selected: ['一'] },
    { id: 'q2', selected: ['二'] },
  ]);
});

test('桥：多题只答一半时整单退回并重画卡片，指出缺哪一题', async () => {
  const { provider, bridge, patches } = fixture();
  const core = coreHandle();
  bridge.attach(core.handle);

  await provider.deliver({
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

  const result = await bridge.applyCardAction({
    eventId: 'ev_multi_half',
    messageId: 'om_1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_owner',
    value: { d: 'dlv_multi' },
    formValues: { answer_0_0: true },
  });

  assert.equal(result.accepted, false);
  if (!result.accepted) assert.equal(result.reason, 'invalid-answer');
  assert.equal(core.answers.length, 0, '缺题不能交核心');
  // 表单提交是一次性的：说明要写回这张卡，勾选框还在。
  assert.equal(patches.length, 1);
  assert.match(JSON.stringify(patches[0]), /第 2 题/u);
  assert.match(JSON.stringify(patches[0]), /"tag":"checker"/u);
});

test('桥：表单作答产物满足核心 validateAnswer 规则', async () => {
  const { provider, bridge } = fixture();
  const core = coreHandle();
  bridge.attach(core.handle);

  const interaction = {
    questions: [
      { id: 'q1', question: '单选', options: [{ label: '一' }, { label: '二' }] },
      { id: 'q2', question: '多选', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] },
      { id: 'q3', question: '自由文本' },
    ],
  };
  await provider.deliver({ ...DELIVERY, id: 'dlv_contract', intent: 'action', interaction });

  const result = await bridge.applyCardAction({
    eventId: 'ev_contract',
    messageId: 'om_1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_owner',
    value: { d: 'dlv_contract' },
    formValues: {
      answer_0_1: true,
      answer_1_0: true,
      answer_1_1: true,
      custom_1: '补充',
      custom_2: ' 自由文本 ',
    },
  });

  assert.deepEqual(result, { accepted: true });
  const answers = core.answers[0]!.answers;
  assert.deepEqual(answers, [
    { id: 'q1', selected: ['二'] },
    { id: 'q2', selected: ['甲', '乙'], custom: '补充' },
    { id: 'q3', selected: [], custom: '自由文本' },
  ]);
  assert.equal(acceptableAnswer(interaction.questions, answers), true);
  // 反例：单选勾了两项，核心会整单拒绝。
  assert.equal(acceptableAnswer(interaction.questions, [{ id: 'q1', selected: ['一', '二'] }]), false);
});

test('桥：交互卡超限时降级为纯文本卡片，回执说明并给出文字作答指引', async () => {
  const { provider, bridge, contents } = fixture({ maxText: 100_000 });
  const questions = Array.from({ length: 10 }, (_, index) => ({
    id: `q${index}`,
    question: `第 ${index + 1} 题`,
    options: Array.from({ length: 21 }, (_, option) => ({ label: `选项 ${option + 1}` })),
  }));

  const receipt = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_big',
    intent: 'action',
    interaction: { questions },
  });

  assert.equal(receipt.status, 'sent');
  assert.match(receipt.error ?? '', /降级为纯文本卡片/u);
  // 降级后没有可点的卡片，不能再登记成「待作答」。
  assert.equal(bridge.interactions.size, 0);

  const card = JSON.parse(contents[0]!) as {
    header: { title: { content: string } };
    body: { elements: Array<{ tag: string; content?: string }> };
  };
  // 标题只在卡片头出现一次，正文不再重复。
  assert.equal(card.header.title.content, '回答');
  assert.equal(card.body.elements.every((element) => element.tag === 'markdown'), true);
  const text = card.body.elements.map((element) => element.content ?? '').join('\n');
  assert.doesNotMatch(text, /\*\*/u);
  assert.match(text, /按题目顺序分行/u);
  assert.match(text, /交互已降级为纯文本卡片/u);
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
    value: { d: 'dlv_ask' },
    formValues: { answer_0_1: true },
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
    value: { d: 'dlv_approve' },
    formValues: { answer_0_0: true },
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
    value: { d: 'dlv_ask2' },
    formValues: { answer_0_0: true },
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
    value: { d: 'dlv_ask2' },
    formValues: { answer_0_0: true },
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
    value: { d: 'dlv_ask2' },
    formValues: { answer_0_0: true },
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

  const base = { messageId: 'om_1', chatId: 'oc_chat', operatorOpenId: 'ou_owner', value: { d: 'dlv_ask2' } };
  const first = await bridge.applyCardAction({ ...base, eventId: 'ev_multi_1', formValues: { answer_0_0: true, answer_0_1: true } });

  assert.equal(first.accepted, false);
  if (!first.accepted) assert.equal(first.reason, 'invalid-answer');
  // 每次拒绝都重画这张卡：飞书的表单提交是一次性的，不重画就没法再提交。
  assert.equal(patches.length, 1);
  assert.match(JSON.stringify(patches[0]), /第 1 题是单选题，只能勾选一项/u);
  assert.equal(core.answers.length, 0);
  // 提示写在卡上，不额外发消息。
  assert.equal(contents.length, 1);

  const ok = await bridge.applyCardAction({ ...base, eventId: 'ev_multi_2', formValues: { answer_0_0: true } });
  assert.deepEqual(ok, { accepted: true });
  assert.deepEqual(core.answers[0]!.answers, [{ id: 'q1', selected: ['甲'] }]);
  assert.equal(patches.length, 2);
  assert.match(JSON.stringify(patches[1]), /已作答/u);
});

test('桥：流式终稿带 completes 才补 DONE，进度修订不补', async () => {
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
    completes: ['oc_chat:om_known'],
    stream: { id: 's1', revision: 2, final: true },
  });
  assert.equal(final.status, 'sent');
  assert.deepEqual(marked, ['om_known']);
});

test('桥：非流式收尾只认 completes；分发回执、停滞、孤儿、转投确认都不带', async () => {
  const marked: string[] = [];
  const { provider, setReply } = fixture({ markDone: (id) => marked.push(id) });
  setReply('om_known');
  const refs = [{ kind: 'session' as const, id: 's_1', title: '会话' }];

  // 正常收尾（核心 conversationGranularity='result' 时没有流）：带 completes。
  const done = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_done',
    inReplyTo: 'oc_chat:om_known',
    refs,
    completes: ['oc_chat:om_known'],
  });
  assert.equal(done.status, 'sent');
  assert.deepEqual(marked, ['om_known']);

  // 这些交付核心都不带 completes：任务还在别处跑 / 结果回不来 / 只是转交确认。
  // 其中转投确认与派发恢复**带 refs**，旧启发式正是因此误打，这里一并钉住。
  const notDone: Array<{ id: string; title: string; refs?: typeof refs; inReplyTo?: string }> = [
    { id: 'dlv_ack', title: '', inReplyTo: 'oc_chat:om_known' },
    { id: 'dlv_stall', title: '长时间没有动静', refs, inReplyTo: 'oc_chat:om_known' },
    { id: 'dlv_orphan', title: '这一轮没有正常收尾', refs, inReplyTo: 'oc_chat:om_known' },
    { id: 'dlv_transfer', title: '已转给会话', refs, inReplyTo: 'oc_chat:om_known' },
    // 标题取自核心 recovery.ts 的真实文案（`派发被打断：…`），不是正文摘要。
    { id: 'dlv_recovery', title: '派发被打断：写周报', refs, inReplyTo: 'oc_chat:om_known' },
  ];
  for (const notice of notDone) {
    const receipt = await provider.deliver({ ...DELIVERY, ...notice, body: '正文' });
    assert.equal(receipt.status, 'sent');
  }
  assert.deepEqual(marked, ['om_known'], '只有带 completes 的那条算完成');
});

test('桥：一条交付完成多条消息时逐个打', async () => {
  const marked: string[] = [];
  const { provider, setReply } = fixture({ markDone: (id) => marked.push(id) });
  setReply('om_known');
  setReply('om_second');

  const receipt = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_multi',
    inReplyTo: 'oc_chat:om_known',
    completes: ['oc_chat:om_known', 'oc_chat:om_second'],
  });
  assert.equal(receipt.status, 'sent');
  assert.deepEqual(marked, ['om_known', 'om_second'], '连发被并成一轮，两条都要打');
});

test('桥：completes 为空或不带该字段时不打（旧核心、取消/失败轮、进度交付）', async () => {
  const marked: string[] = [];
  const { provider, setReply } = fixture({ markDone: (id) => marked.push(id) });
  setReply('om_known');

  const empty = await provider.deliver({ ...DELIVERY, id: 'dlv_empty', inReplyTo: 'oc_chat:om_known', completes: [] });
  assert.equal(empty.status, 'sent');

  // 旧核心：正常收尾的形状（带 refs、带 inReplyTo）但没有 completes —— 旧启发式会打，现在不打。
  const legacy = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_legacy',
    inReplyTo: 'oc_chat:om_known',
    refs: [{ kind: 'session', id: 's_1', title: '会话' }],
  });
  assert.equal(legacy.status, 'sent');

  // 取消 / 失败 / 超出 token 上限而中断的一轮：终稿照发，但核心不列 completes（没有正常答复）。
  const aborted = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_aborted',
    body: '这一轮被取消了',
    inReplyTo: 'oc_chat:om_known',
    stream: { id: 's_abort', revision: 1, final: true },
  });
  assert.equal(aborted.status, 'sent');
  assert.deepEqual(marked, [], '漏打优于误打');
});

test('桥：发送失败或 completes 里的 id 查不到映射时不补 DONE', async () => {
  const marked: string[] = [];
  const debugs: unknown[][] = [];
  const { provider, setReply } = fixture({
    markDone: (id) => marked.push(id),
    logger: { debug: (...args) => debugs.push(args) },
  });
  setReply('om_known');

  // 收件人翻译不出会话：交付失败，只留「收到」。
  const failed = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_fail',
    recipient: 'ou_nobody',
    inReplyTo: 'oc_chat:om_known',
    completes: ['oc_chat:om_known'],
    stream: { id: 's2', revision: 1, final: true },
  });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(marked, []);

  // 重启丢了入站映射：completes 指过来也翻不出平台消息 id。
  const unknown = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_unknown',
    inReplyTo: 'oc_chat:om_known',
    completes: ['oc_chat:om_gone'],
    stream: { id: 's3', revision: 1, final: true },
  });
  assert.equal(unknown.status, 'sent');
  assert.deepEqual(marked, []);
  assert.equal(debugs.length, 1, '少打 DONE 时留一条调试日志，否则线上无从排查');
  assert.match(String(debugs[0]![1]), /om_gone/u);
});

test('桥：卡片作答的 card: id 翻不出平台消息，不打标记', async () => {
  const marked: string[] = [];
  const { provider, setReply } = fixture({ markDone: (id) => marked.push(id) });
  setReply('om_known');

  // 卡片上写的文字作答没有平台消息 id，核心回 `card:<交付 id>`；即便列进 completes 也翻不出来。
  const fromCard = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_card',
    inReplyTo: 'card:dlv_card_prev',
    completes: ['card:dlv_card_prev'],
  });
  assert.equal(fromCard.status, 'sent');
  assert.deepEqual(marked, []);
});

test('桥：流式卡片超限改分条后，终稿内容仍要发出并补一次 DONE', async () => {
  const marked: string[] = [];
  // 正文大到渲染出的卡片必然超过 28 KB：第一次修订就走「分条最终稿」，并把这条流标记为不再原地更新。
  const { provider, setReply, contents } = fixture({ maxText: 4000, markDone: (id) => marked.push(id) });
  setReply('om_known');

  const first = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_big_1',
    body: '很长的正文'.repeat(2500),
    inReplyTo: 'oc_chat:om_known',
    stream: { id: 's_big', revision: 1, final: false },
  });
  assert.equal(first.status, 'sent');
  const beforeFinal = contents.length;
  assert.ok(beforeFinal > 0);

  // 证明这条流确实进了「分条」状态：后续中间修订只回执，不再发消息。
  const quiet = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_big_1b',
    body: '中间进度',
    inReplyTo: 'oc_chat:om_known',
    stream: { id: 's_big', revision: 2, final: false },
  });
  assert.equal(quiet.messagesSent, 0);
  assert.equal(contents.length, beforeFinal);

  const final = await provider.deliver({
    ...DELIVERY,
    id: 'dlv_big_2',
    body: `最终答案：${'这里是结论。'.repeat(1700)}`,
    inReplyTo: 'oc_chat:om_known',
    completes: ['oc_chat:om_known'],
    stream: { id: 's_big', revision: 3, final: true },
  });
  assert.equal(final.status, 'sent');
  // 终稿与中间修订内容不同，不能因为「这条流改过分条」就把它吞掉。
  assert.ok(contents.length > beforeFinal, '终稿必须真的发出去');
  assert.match(JSON.stringify(contents.slice(beforeFinal)), /最终答案/u);
  assert.equal(marked.length, 1, '分条后的终稿仍要给原消息补一次');
  assert.deepEqual(marked, ['om_known']);
});
