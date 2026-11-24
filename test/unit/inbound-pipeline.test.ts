import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLarkBridge } from '../../src/host/bridge.ts';
import { InboundPipeline } from '../../src/host/inbound-pipeline.ts';
import type { LarkApi } from '../../src/host/lark/api.ts';
import type { LarkBridge } from '../../src/host/bridge.ts';
import type { BridgeHandle, OwnerMessageDraft } from '../../src/host/protocol.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface SetupOptions {
  features?: string[];
  ownerOpenId?: string;
  typing?: boolean;
  imageBytes?: Uint8Array;
  downloadFails?: boolean;
  isOwner?: (sender: string) => boolean | undefined;
  claimCard?: (action: { value: Record<string, unknown>; option?: unknown }) => boolean;
}

function setup(options: SetupOptions = {}) {
  const received: OwnerMessageDraft[] = [];
  const answers: Array<{ deliveryId: string; answers: Array<{ id: string; selected: readonly string[] }> }> = [];
  const reactions: string[] = [];
  const removed: string[] = [];
  const patches: unknown[] = [];
  const downloads: Array<{ type: 'image' | 'file'; key: string }> = [];

  const api: LarkApi = {
    async createMessage() {
      return { messageId: `om_${patches.length + 1}` };
    },
    async replyMessage() {
      return { messageId: 'om_reply' };
    },
    async patchCard(input) {
      patches.push(input.card);
    },
    async recallMessage() {},
    async addReaction({ emojiType }) {
      reactions.push(emojiType);
      return { reactionId: `re_${reactions.length}` };
    },
    async removeReaction({ reactionId }) {
      removed.push(reactionId);
    },
    async uploadImage() {
      return { imageKey: 'img' };
    },
    async uploadFile() {
      return { fileKey: 'file' };
    },
    async downloadResource({ type, fileKey }) {
      downloads.push({ type, key: fileKey });
      if (options.downloadFails === true) throw new Error('下载失败');
      return { bytes: options.imageBytes ?? PNG, contentType: 'image/png' };
    },
  };

  const bridge = createLarkBridge({ account: 'cli_test', api });

  const handle: BridgeHandle = {
    id: 'lark:cli_test',
    protocol: 'my-superagent/v1',
    async receive(message) {
      received.push(message);
      return { accepted: true };
    },
    async answer(answer) {
      answers.push(answer as never);
      return { accepted: true };
    },
    update() {},
    commands: () => [],
    isOwner: () => true,
    dispose() {},
  };
  bridge.attach(handle);

  const pipeline = new InboundPipeline({
    api,
    bridge,
    typing: options.typing ?? true,
    ...(options.ownerOpenId === undefined ? {} : { ownerOpenId: () => options.ownerOpenId }),
    features: () => options.features ?? [],
    ...(options.isOwner === undefined ? {} : { isOwner: options.isOwner }),
    ...(options.claimCard === undefined ? {} : { claimCard: options.claimCard }),
  });

  return { pipeline, bridge, api, received, answers, reactions, removed, patches, downloads };
}

let sequence = 0;
function messageEvent(fields: {
  text?: string;
  chatType?: 'p2p' | 'group';
  sender?: string;
  messageType?: string;
  content?: string;
  parentId?: string;
  mentions?: unknown[];
} = {}): unknown {
  sequence += 1;
  return {
    schema: '2.0',
    header: { event_id: `ev_${sequence}`, event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: fields.sender ?? 'ou_owner' }, sender_type: 'user' },
      message: {
        message_id: `om_${sequence}`,
        chat_id: 'oc_1',
        chat_type: fields.chatType ?? 'p2p',
        message_type: fields.messageType ?? 'text',
        content: fields.content ?? JSON.stringify({ text: fields.text ?? '你好' }),
        create_time: '1760000000000',
        ...(fields.parentId === undefined ? {} : { parent_id: fields.parentId }),
        ...(fields.mentions === undefined ? {} : { mentions: fields.mentions }),
      },
    },
  };
}

function cardActionEvent(value: Record<string, unknown>, operator = 'ou_owner'): unknown {
  return {
    schema: '2.0',
    header: { event_id: `ev_card_${(sequence += 1)}`, event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: operator },
      action: { value, tag: 'button' },
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
    },
  };
}

/** 真机的表单提交回调：没有 `event_id`，勾选值在 `form_value` 里。 */
function formSubmitEvent(value: Record<string, unknown>, formValues: Record<string, unknown>): unknown {
  return {
    schema: '2.0',
    header: { event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou_owner' },
      action: { value, tag: 'button', form_value: formValues },
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
    },
  };
}

test('流水线：文本事件转成协议草稿，带平台消息 id 与回复引用', async () => {
  const { pipeline, received } = setup();
  pipeline.handleMessage(messageEvent({ text: '帮我看下', parentId: 'om_parent' }));
  await pipeline.drain();

  assert.equal(received.length, 1);
  const draft = received[0]!;
  assert.equal(draft.messageId, 'oc_1:om_1');
  assert.equal(draft.platformMessageId, 'om_1');
  assert.equal(draft.sender, 'ou_owner');
  assert.equal(draft.text, '帮我看下');
  assert.equal(draft.replyTo, 'om_parent');
  assert.equal(draft.at, 1760000000000);
});

test('流水线：同步返回，真正的处理在队列里', async () => {
  const { pipeline, received } = setup();
  pipeline.handleMessage(messageEvent({ text: '异步' }));
  assert.equal(received.length, 0, 'handleMessage 不应等待核心');
  await pipeline.drain();
  assert.equal(received.length, 1);
});

test('流水线：重复投递只处理一次', async () => {
  const { pipeline, received } = setup();
  const event = messageEvent({ text: '同一条' });
  pipeline.handleMessage(event);
  pipeline.handleMessage(event);
  await pipeline.drain();
  assert.equal(received.length, 1);
});

test('流水线：群里没 @机器人 的消息不进核心', async () => {
  const { pipeline, received } = setup();
  pipeline.handleMessage(messageEvent({ chatType: 'group', mentions: [] }));
  await pipeline.drain();
  assert.equal(received.length, 0);
});

test('流水线：非主人消息被忽略（不解析命令、不驱动会话）', async () => {
  const { pipeline, received } = setup({ ownerOpenId: 'ou_owner' });
  pipeline.handleMessage(messageEvent({ sender: 'ou_stranger', text: '/new' }));
  await pipeline.drain();
  assert.equal(received.length, 0);
});

test('流水线：收到只打 Get，入队不打 DONE（完成标记由交付路径补）', async () => {
  const { pipeline, reactions, removed } = setup();
  pipeline.handleMessage(messageEvent({ text: '打个表情' }));
  await pipeline.drain();

  assert.deepEqual(reactions, ['Get']);
  assert.deepEqual(removed, []);
});

test('流水线：处理抛错只留 Get（不撤销、入队也不追加 DONE）', async () => {
  const reactions: string[] = [];
  const removed: string[] = [];
  const pipeline = new InboundPipeline({
    api: {
      ...setup().api,
      async addReaction({ emojiType }) {
        reactions.push(emojiType);
        return { reactionId: `re_${reactions.length}` };
      },
      async removeReaction({ reactionId }) {
        removed.push(reactionId);
      },
    },
    bridge: {
      receive: async () => {
        throw new Error('核心接收失败');
      },
    } as unknown as LarkBridge,
    typing: true,
  });

  pipeline.handleMessage(messageEvent({ text: '会失败的' }));
  await pipeline.drain();

  assert.deepEqual(reactions, ['Get']);
  assert.deepEqual(removed, []);
});

test('流水线：关掉输入状态时两种表情都不打', async () => {
  const { pipeline, reactions, removed } = setup({ typing: false });
  pipeline.handleMessage(messageEvent({ text: '不打表情' }));
  await pipeline.drain();

  assert.deepEqual(reactions, []);
  assert.deepEqual(removed, []);
});

test('流水线：核心没声明 owner-images 时不下载图片，也不带字节', async () => {
  const { pipeline, received, downloads } = setup();
  pipeline.handleMessage(
    messageEvent({ messageType: 'image', content: JSON.stringify({ image_key: 'img_1' }) }),
  );
  await pipeline.drain();

  assert.deepEqual(downloads, []);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.images, undefined);
});

test('流水线：核心说发送者不是主人时，图片不下载但文字照常上报', async () => {
  const { pipeline, received, downloads } = setup({
    features: ['owner-images'],
    isOwner: () => false,
  });
  pipeline.handleMessage(
    messageEvent({ messageType: 'image', content: JSON.stringify({ image_key: 'img_1' }) }),
  );
  await pipeline.drain();

  assert.deepEqual(downloads, []);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.images, undefined);
  assert.match(received[0]!.text, /非主人消息/);
});

test('流水线：核心声明 owner-images 时下载并按 base64 上报', async () => {
  const { pipeline, received, downloads } = setup({ features: ['owner-images'] });
  pipeline.handleMessage(
    messageEvent({ messageType: 'image', content: JSON.stringify({ image_key: 'img_1' }) }),
  );
  await pipeline.drain();

  assert.deepEqual(downloads, [{ type: 'image', key: 'img_1' }]);
  const image = received[0]!.images![0]!;
  assert.equal(image.mediaType, 'image/png');
  assert.equal(image.data, Buffer.from(PNG).toString('base64'));
  assert.equal(image.name, '图片.png');
});

test('流水线：图片超过上限或格式不认时降级成文字说明', async () => {
  const big = new Uint8Array(10 * 1024 * 1024 + 1);
  const { pipeline, received } = setup({ features: ['owner-images'], imageBytes: big });
  pipeline.handleMessage(messageEvent({ messageType: 'image', content: JSON.stringify({ image_key: 'img_big' }) }));
  await pipeline.drain();

  assert.equal(received[0]!.images, undefined);
  assert.match(received[0]!.text, /超过 10 MB/);
});

test('流水线：下载失败不让消息消失，转成文字说明', async () => {
  const { pipeline, received } = setup({ features: ['owner-images'], downloadFails: true });
  pipeline.handleMessage(messageEvent({ messageType: 'image', content: JSON.stringify({ image_key: 'img_x' }) }));
  await pipeline.drain();

  assert.equal(received.length, 1);
  assert.equal(received[0]!.images, undefined);
  assert.match(received[0]!.text, /未能下载/);
});

test('流水线：文件保留叶子名与可选的 media-type', async () => {
  const { pipeline, received } = setup({ features: ['owner-files'] });
  pipeline.handleMessage(
    messageEvent({
      messageType: 'file',
      content: JSON.stringify({ file_key: 'file_1', file_name: '../../日志.txt' }),
    }),
  );
  await pipeline.drain();

  const file = received[0]!.files![0]!;
  assert.equal(file.name, '日志.txt');
  assert.equal(file.mediaType, 'text/plain');
});

test('流水线：暂不支持的消息变成一句可回复的提示', async () => {
  const { pipeline, received } = setup();
  pipeline.handleMessage(messageEvent({ messageType: 'audio', content: '{}' }));
  await pipeline.drain();

  assert.match(received[0]!.text, /暂不支持的消息类型：audio/);
});

test('流水线：卡片回调转成作答，并改写终态卡', async () => {
  const { pipeline, bridge, answers, patches, api } = setup();

  // 先发一张带交互的卡，才有待作答记录。
  await bridge.provider.deliver({
    protocol: 'my-superagent/v1',
    id: 'dlv_ask',
    recipient: 'oc_1',
    intent: 'action',
    title: '选择',
    body: '请选',
    interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }] },
  });

  pipeline.handleCardAction(cardActionEvent({ d: 'dlv_ask', q: 'q1', o: 0 }));
  await pipeline.drain();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0]!.answers, [{ id: 'q1', selected: ['甲'] }]);
  assert.equal(patches.length, 1);
  void api;
});

test('流水线：提醒先认领卡片回调，认领后不再交给核心桥', async () => {
  const claimed: Array<{ value: Record<string, unknown>; option?: unknown }> = [];
  const { pipeline, bridge, answers } = setup({
    claimCard: (action) => {
      claimed.push(action);
      return true;
    },
  });
  await bridge.provider.deliver({
    protocol: 'my-superagent/v1',
    id: 'dlv_ask',
    recipient: 'oc_1',
    intent: 'action',
    title: '选择',
    body: '请选',
    interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }] }] },
  });

  pipeline.handleCardAction(cardActionEvent({ r: 'lark-q-1', q: 'q1', o: 0 }));
  await pipeline.drain();

  assert.equal(claimed.length, 1);
  assert.deepEqual(claimed[0]!.value, { r: 'lark-q-1', q: 'q1', o: 0 });
  assert.equal(answers.length, 0);
});

test('流水线：提醒认不出卡片回调时仍交给核心桥', async () => {
  const { pipeline, bridge, answers } = setup({ claimCard: () => false });
  await bridge.provider.deliver({
    protocol: 'my-superagent/v1',
    id: 'dlv_ask',
    recipient: 'oc_1',
    intent: 'action',
    title: '选择',
    body: '请选',
    interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }] }] },
  });

  pipeline.handleCardAction(cardActionEvent({ d: 'dlv_ask', q: 'q1', o: 0 }));
  await pipeline.drain();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(answers.length, 1);
});

test('流水线：非主人的卡片回调被忽略', async () => {
  const { pipeline, bridge, answers } = setup({ ownerOpenId: 'ou_owner' });
  await bridge.provider.deliver({
    protocol: 'my-superagent/v1',
    id: 'dlv_ask',
    recipient: 'oc_1',
    intent: 'action',
    title: '选择',
    body: '请选',
    interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }] }] },
  });

  pipeline.handleCardAction(cardActionEvent({ d: 'dlv_ask', q: 'q1', o: 0 }, 'ou_stranger'));
  await pipeline.drain();
  assert.equal(answers.length, 0);
});

test('流水线：同一张卡改选项再提交仍会被处理', async () => {
  const { pipeline, bridge, answers } = setup();
  await bridge.provider.deliver({
    protocol: 'my-superagent/v1',
    id: 'dlv_form',
    recipient: 'oc_1',
    intent: 'action',
    title: '选择',
    body: '请选',
    interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }] },
  });

  // 第一次提交勾了两项：被拒（单选只能一项），但待作答要保留。
  pipeline.handleCardAction(formSubmitEvent({ d: 'dlv_form', q: 'q1' }, { answer_0: true, answer_1: true }));
  await pipeline.drain();
  assert.equal(answers.length, 0);

  // 改勾一项再提交：同样的 value、同样的消息 id，只有 form_value 变了。
  // 去重键如果只看 value，这次会被当成平台重推丢掉——真机上的「此后不能再答」。
  pipeline.handleCardAction(formSubmitEvent({ d: 'dlv_form', q: 'q1' }, { answer_0: true }));
  await pipeline.drain();

  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0]!.answers, [{ id: 'q1', selected: ['甲'] }]);
});

test('流水线：同一份表单回调在重推窗口内只处理一次', async () => {
  const { pipeline, bridge, answers } = setup();
  await bridge.provider.deliver({
    protocol: 'my-superagent/v1',
    id: 'dlv_form',
    recipient: 'oc_1',
    intent: 'action',
    title: '选择',
    body: '请选',
    interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }] },
  });

  const event = formSubmitEvent({ d: 'dlv_form', q: 'q1' }, { answer_0: true });
  pipeline.handleCardAction(event);
  pipeline.handleCardAction(event);
  await pipeline.drain();

  assert.equal(answers.length, 1);
});

test('流水线：队列按到达顺序处理', async () => {
  const { pipeline, received } = setup();
  pipeline.handleMessage(messageEvent({ text: '第一条' }));
  pipeline.handleMessage(messageEvent({ text: '第二条' }));
  pipeline.handleMessage(messageEvent({ text: '第三条' }));
  await pipeline.drain();

  assert.deepEqual(
    received.map((draft) => draft.text),
    ['第一条', '第二条', '第三条'],
  );
});
