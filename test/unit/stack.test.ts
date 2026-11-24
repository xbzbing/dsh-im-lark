import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultSettings, normalizePluginConfig } from '../../src/host/config.ts';
import type { LarkApi } from '../../src/host/lark/api.ts';
import { createLarkStack } from '../../src/host/stack.ts';
import { DirectBindingStore, OwnerStore } from '../../src/host/state/direct.ts';
import { withTempDir } from './helpers/temp.ts';

/** 只记录表情回应：栈的职责是「什么时候打、打给谁」，其余能力不参与本用例。 */
function fakeApi(reactions: Array<{ messageId: string; emojiType: string }>): LarkApi {
  return {
    async createMessage() {
      return { messageId: 'om_sent' };
    },
    async replyMessage() {
      return { messageId: 'om_sent' };
    },
    async patchCard() {},
    async recallMessage() {},
    async addReaction({ messageId, emojiType }) {
      reactions.push({ messageId, emojiType });
      return { reactionId: `re_${reactions.length}` };
    },
    async removeReaction() {},
    async uploadImage() {
      return { imageKey: 'img' };
    },
    async uploadFile() {
      return { fileKey: 'file' };
    },
    async downloadResource() {
      return { bytes: new Uint8Array() };
    },
  };
}

async function withStack(
  options: { typing?: boolean },
  run: (context: {
    stack: ReturnType<typeof createLarkStack>;
    reactions: Array<{ messageId: string; emojiType: string }>;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const reactions: Array<{ messageId: string; emojiType: string }> = [];
    const config = normalizePluginConfig({});
    const stack = createLarkStack({
      app: { appId: 'cli_test', appSecret: 'secret', domain: 'feishu' },
      config,
      logger: {},
      settings: () => defaultSettings(config),
      bindings: new DirectBindingStore({ dataDir: dir.path }),
      owners: new OwnerStore({ dataDir: dir.path }),
      controller: () => null,
      createApi: () => fakeApi(reactions),
      ...(options.typing === undefined ? {} : { typing: options.typing }),
    });
    try {
      await run({ stack, reactions });
    } finally {
      stack.dispose();
    }
  });
}

test('栈：「处理状态表情」打开时收到打 Get，回答送达后按原消息补一次 DONE', async () => {
  await withStack({ typing: true }, async ({ stack, reactions }) => {
    stack.pipeline.handleMessage({
      schema: '2.0',
      header: { event_id: 'ev_1', event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
        message: {
          message_id: 'om_src',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '你好' }),
          create_time: '1760000000000',
        },
      },
    });
    await stack.pipeline.drain();
    assert.deepEqual(reactions, [{ messageId: 'om_src', emojiType: 'Get' }], '入队只打收到');

    // 核心回一条正常收尾（流式终稿）：给原消息补 DONE。
    const receipt = await stack.bridge.provider.deliver({
      protocol: 'my-superagent/v1',
      id: 'dlv_1',
      recipient: 'ou_owner',
      intent: 'result',
      title: '回答',
      body: '正文',
      inReplyTo: 'oc_1:om_src',
      stream: { id: 's1', revision: 1, final: true },
    });
    assert.equal(receipt.status, 'sent');
    assert.deepEqual(reactions, [
      { messageId: 'om_src', emojiType: 'Get' },
      { messageId: 'om_src', emojiType: 'DONE' },
    ]);

    // 同一条消息再来一次收尾（重投/多条 result）：不重复加表情。
    await stack.bridge.provider.deliver({
      protocol: 'my-superagent/v1',
      id: 'dlv_1_retry',
      recipient: 'ou_owner',
      intent: 'result',
      title: '回答',
      body: '正文',
      inReplyTo: 'oc_1:om_src',
      stream: { id: 's2', revision: 1, final: true },
    });
    assert.equal(reactions.filter((item) => item.emojiType === 'DONE').length, 1, '同一原消息只补一次');
  });
});

test('栈：关掉「处理状态表情」时 Get 与 DONE 都不打', async () => {
  await withStack({ typing: false }, async ({ stack, reactions }) => {
    stack.pipeline.handleMessage({
      schema: '2.0',
      header: { event_id: 'ev_1', event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
        message: {
          message_id: 'om_src',
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '你好' }),
          create_time: '1760000000000',
        },
      },
    });
    await stack.pipeline.drain();
    await stack.bridge.provider.deliver({
      protocol: 'my-superagent/v1',
      id: 'dlv_1',
      recipient: 'ou_owner',
      intent: 'result',
      title: '回答',
      body: '正文',
      inReplyTo: 'oc_1:om_src',
      stream: { id: 's1', revision: 1, final: true },
    });
    assert.deepEqual(reactions, []);
  });
});
