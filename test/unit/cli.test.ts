import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArgs, runCli } from '../../src/host/cli-send.ts';
import type { CliPorts } from '../../src/host/cli-send.ts';
import type { LarkApi } from '../../src/host/lark/api.ts';

const APP = { appId: 'cli_aaaabbbbcccc', appSecret: 'yku-secret-value', domain: 'feishu' as const };

function fakeApi(options: { fail?: boolean } = {}): { api: LarkApi; sent: Array<{ chatId: string; content: string }> } {
  const sent: Array<{ chatId: string; content: string }> = [];
  const api: LarkApi = {
    async createMessage(input) {
      if (options.fail === true) throw new Error('平台拒绝');
      sent.push({ chatId: input.chatId, content: input.content });
      return { messageId: 'om_1' };
    },
    async replyMessage() {
      return { messageId: 'om_2' };
    },
    async patchCard() {},
    async recallMessage() {},
    async addReaction() {
      return { reactionId: 're' };
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
  return { api, sent };
}

function portsOf(overrides: Partial<CliPorts> = {}): { ports: CliPorts; out: string[] } {
  const out: string[] = [];
  const ports: CliPorts = {
    loadApp: async () => APP,
    ownerChat: async () => 'oc_1',
    createApi: () => fakeApi().api,
    write: (line) => out.push(line),
    ...overrides,
  };
  return { ports, out };
}

test('CLI 参数：只认 text / status / help', () => {
  assert.deepEqual(parseArgs([]), { kind: 'help' });
  assert.deepEqual(parseArgs(['help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['status']), { kind: 'status' });
  assert.deepEqual(parseArgs(['text', '你好', '世界']), { kind: 'text', text: '你好 世界' });
  assert.deepEqual(parseArgs(['text']), { kind: 'help' });
  assert.deepEqual(parseArgs(['--to', 'ou_x', 'hi']), { kind: 'help' });
});

test('CLI：help 打印用法并以 0 退出', async () => {
  const { ports, out } = portsOf();
  assert.equal(await runCli(['help'], { ports }), 0);
  assert.match(out.join('\n'), /dsh-lark-send/);
});

test('CLI：没配凭据时报错并以 1 退出', async () => {
  const { ports, out } = portsOf({ loadApp: async () => null });
  assert.equal(await runCli(['text', '你好'], { ports }), 1);
  assert.match(out.join('\n'), /还没有配置凭据/);
});

test('CLI：status 只显示尾号与收件人状态', async () => {
  const { ports, out } = portsOf({ ownerChat: async () => 'oc_1' });
  assert.equal(await runCli(['status'], { ports }), 0);
  assert.match(out.join('\n'), /…bbcccc/);
  assert.match(out.join('\n'), /已绑定/);
  assert.equal(out.join('\n').includes(APP.appSecret), false);
});

test('CLI：text 发给主人的会话，成功回条数', async () => {
  const { api, sent } = fakeApi();
  const { ports, out } = portsOf({ createApi: () => api });

  assert.equal(await runCli(['text', '你好'], { ports }), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, 'oc_1');
  assert.match(sent[0]!.content, /你好/);
  assert.match(out.join('\n'), /已发送/);
});

test('CLI：没有主人时拒绝发送', async () => {
  const { ports, out } = portsOf({ ownerChat: async () => null });
  assert.equal(await runCli(['text', '你好'], { ports }), 1);
  assert.match(out.join('\n'), /还没有主人/);
});

test('CLI：平台失败以 1 退出，不谎报成功', async () => {
  const { ports, out } = portsOf({ createApi: () => fakeApi({ fail: true }).api });
  assert.equal(await runCli(['text', '你好'], { ports }), 1);
  assert.match(out.join('\n'), /发送失败/);
});
