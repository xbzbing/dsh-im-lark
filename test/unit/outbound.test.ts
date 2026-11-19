import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cardBytes } from '../../src/host/cards.ts';
import { LarkFailure } from '../../src/host/lark/errors.ts';
import type { LarkApi } from '../../src/host/lark/api.ts';
import type { LarkSendOptions, LarkSendResult } from '../../src/host/lark/types.ts';
import {
  OutboundChannel,
  fileTypeOf,
  idempotencyKey,
  shrinkToCardLimit,
  splitMarkdown,
} from '../../src/host/outbound.ts';

interface Sent {
  kind: 'message' | 'reply';
  chatId?: string;
  messageId?: string;
  msgType: string;
  content: string;
  options?: LarkSendOptions;
}

/** 记录调用的假端口：按需注入一次性失败。 */
function fakeApi(): { api: LarkApi; sent: Sent[]; uploads: string[]; failures: LarkFailure[] } {
  const sent: Sent[] = [];
  const uploads: string[] = [];
  const failures: LarkFailure[] = [];
  let sequence = 0;

  const nextId = (): string => `om_${++sequence}`;

  const api: LarkApi = {
    async createMessage(input) {
      if (failures.length > 0) throw failures.shift();
      sent.push({ kind: 'message', chatId: input.chatId, msgType: input.msgType, content: input.content, options: input.options });
      return { messageId: nextId() } satisfies LarkSendResult;
    },
    async replyMessage(input) {
      if (failures.length > 0) throw failures.shift();
      sent.push({
        kind: 'reply',
        messageId: input.messageId,
        msgType: input.msgType,
        content: input.content,
        options: input.options,
      });
      return { messageId: nextId() } satisfies LarkSendResult;
    },
    async patchCard() {},
    async recallMessage() {},
    async addReaction() {
      return { reactionId: 're_1' };
    },
    async removeReaction() {},
    async uploadImage({ fileName }) {
      uploads.push(`image:${fileName}`);
      return { imageKey: 'img_key_1' };
    },
    async uploadFile({ fileName }) {
      uploads.push(`file:${fileName}`);
      return { fileKey: 'file_key_1' };
    },
    async downloadResource() {
      return { bytes: new Uint8Array() };
    },
  };

  return { api, sent, uploads, failures };
}

test('分条：短文本原样一段', () => {
  assert.deepEqual(splitMarkdown('你好', 100), ['你好']);
});

test('分条：空文本不产生空气泡', () => {
  assert.deepEqual(splitMarkdown('   \n\n ', 100), []);
});

test('分条：超长文本按段落切，每段都不超限', () => {
  const paragraph = '第一段内容。'.repeat(20);
  const text = Array.from({ length: 6 }, (_, index) => `${index}:${paragraph}`).join('\n\n');
  const segments = splitMarkdown(text, 200);

  assert.ok(segments.length > 1);
  for (const segment of segments) assert.ok(segment.length <= 200, `超限：${segment.length}`);
  const joined = segments.join('\n\n');
  for (let index = 0; index < 6; index += 1) assert.ok(joined.includes(`${index}:`), `丢了第 ${index} 段`);
});

test('分条：代码块跨段时补围栏，每段围栏成对', () => {
  const code = Array.from({ length: 60 }, (_, index) => `const value${index} = ${index};`).join('\n');
  const text = `说明如下：\n\n\`\`\`ts\n${code}\n\`\`\``;
  const segments = splitMarkdown(text, 220);

  assert.ok(segments.length > 2);
  for (const segment of segments) {
    const fences = segment.split('\n').filter((line) => line.trim().startsWith('```')).length;
    assert.equal(fences % 2, 0, `围栏不成对：\n${segment}`);
    assert.ok(segment.length <= 220);
  }
  const joined = segments.join('\n');
  assert.ok(joined.includes('const value0 = 0;'));
  assert.ok(joined.includes('const value59 = 59;'));
});

test('交付：分条发送，首条走回复、其余走群发', async () => {
  const { api, sent } = fakeApi();
  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 40 });

  const receipt = await channel.deliver({
    deliveryId: 'dlv_1',
    replyTo: 'om_parent',
    text: '第一段。'.repeat(30),
  });

  assert.ok(receipt.messagesSent >= 2);
  assert.equal(receipt.errorCode, undefined);
  assert.equal(sent[0]!.kind, 'reply');
  assert.equal(sent[0]!.messageId, 'om_parent');
  assert.equal(sent[0]!.msgType, 'interactive');
  for (const item of sent.slice(1)) {
    assert.equal(item.kind, 'message');
  }
  assert.deepEqual(receipt.messageIds, sent.map((_, index) => `om_${index + 1}`));
});

test('交付：同一 deliveryId 重投不重复发，返回 reused', async () => {
  const { api, sent } = fakeApi();
  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 2000 });

  const first = await channel.deliver({ deliveryId: 'dlv_same', text: '一次就好' });
  const second = await channel.deliver({ deliveryId: 'dlv_same', text: '一次就好' });

  assert.equal(sent.length, 1);
  assert.equal(second.reused, true);
  assert.deepEqual(second.messageIds, first.messageIds);
});

test('交付：已过期直接回 window-closed，不碰平台', async () => {
  const { api, sent } = fakeApi();
  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 2000, now: () => 10_000 });

  const receipt = await channel.deliver({ deliveryId: 'dlv_late', text: '迟到了', expiresAt: 9_999 });
  assert.equal(receipt.errorCode, 'window-closed');
  assert.equal(receipt.messagesSent, 0);
  assert.equal(sent.length, 0);
});

test('交付：频控失败按退避重试，成功后回执正常', async () => {
  const { api, sent, failures } = fakeApi();
  failures.push(new LarkFailure({ kind: 'rate-limited', message: 'too many requests', retryAfterMs: 100 }));

  const waits: number[] = [];
  const channel = new OutboundChannel({
    api,
    chatId: 'oc_1',
    maxText: 2000,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });

  const receipt = await channel.deliver({ deliveryId: 'dlv_rate', text: '重试一次' });
  assert.equal(receipt.errorCode, undefined);
  assert.equal(sent.length, 1);
  assert.equal(waits.length, 1);
  assert.ok(waits[0]! >= 100);
});

test('交付：鉴权失败不重试，映射成 auth-expired', async () => {
  const { api, sent, failures } = fakeApi();
  failures.push(new LarkFailure({ kind: 'auth', code: 99991663, message: 'token invalid' }));

  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 2000, sleep: async () => {} });
  const receipt = await channel.deliver({ deliveryId: 'dlv_auth', text: '发不出去' });

  assert.equal(receipt.errorCode, 'auth-expired');
  assert.equal(receipt.messagesSent, 0);
  assert.equal(sent.length, 0);
});

test('交付：网络错误重试到上限后回 other，重投从断点续发', async () => {
  const { api, sent } = fakeApi();
  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 30, sleep: async () => {} });

  // 第一段正常发出，第二段连续失败三次（等于 maxAttempts）。
  const first = await channel.deliver({ deliveryId: 'dlv_partial', text: '甲'.repeat(70) });
  assert.equal(first.errorCode, undefined);
  assert.equal(sent.length, first.messagesSent);

  // 再来一次同样的交付：命中幂等表，不会重复发。
  const again = await channel.deliver({ deliveryId: 'dlv_partial', text: '甲'.repeat(70) });
  assert.equal(again.reused, true);
  assert.equal(sent.length, first.messagesSent);

  // 换一个 id、但让第一段之后失败：回执带 other，且已发条数如实上报。
  const other = fakeApi();
  other.failures.push(
    new LarkFailure({ kind: 'network', message: 'boom 1' }),
    new LarkFailure({ kind: 'network', message: 'boom 2' }),
    new LarkFailure({ kind: 'network', message: 'boom 3' }),
  );
  const failing = new OutboundChannel({ api: other.api, chatId: 'oc_1', maxText: 2000, sleep: async () => {} });
  const bad = await failing.deliver({ deliveryId: 'dlv_bad', text: '发一次' });

  assert.equal(bad.errorCode, 'other');
  assert.equal(bad.messagesSent, 0);
  assert.equal(other.sent.length, 0);

  // 恢复后同 id 重投能成功（断点在 0，从头发）。
  const recovered = await failing.deliver({ deliveryId: 'dlv_bad', text: '发一次' });
  assert.equal(recovered.errorCode, undefined);
  assert.equal(other.sent.length, 1);
});

test('交付：第二段失败后重投只发剩余段，不重复已发内容', async () => {
  const base = fakeApi();
  let calls = 0;
  const api: LarkApi = {
    ...base.api,
    async createMessage(input) {
      calls += 1;
      if (calls >= 2 && calls <= 4) throw new LarkFailure({ kind: 'network', message: '断网' });
      return base.api.createMessage(input);
    },
  };
  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 30, sleep: async () => {} });
  const text = '甲'.repeat(70);

  const first = await channel.deliver({ deliveryId: 'dlv_resume', text });
  assert.equal(first.errorCode, 'other');
  assert.equal(first.messagesSent, 1);
  assert.equal(base.sent.length, 1);

  const retry = await channel.deliver({ deliveryId: 'dlv_resume', text });
  assert.equal(retry.errorCode, undefined);
  assert.ok(retry.messagesSent > 1);
  // 第一次发了 1 条，重投只补后面的 2 条（总共 3 条，不重发第 1 条）。
  assert.equal(base.sent.length, retry.messagesSent);
});

test('交付：分段超过上限直接拒绝，不刷屏', async () => {
  const { api, sent } = fakeApi();
  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 200 });

  const receipt = await channel.deliver({ deliveryId: 'dlv_huge', text: '甲'.repeat(6_200) });
  assert.equal(receipt.errorCode, 'too-long');
  assert.match(receipt.error ?? '', /上限/);
  assert.equal(sent.length, 0);
});

test('交付：同 id 重投但内容变了，不把新内容接在旧交付后面', async () => {
  const base = fakeApi();
  let calls = 0;
  const api: LarkApi = {
    ...base.api,
    async createMessage(input) {
      calls += 1;
      if (calls >= 2 && calls <= 4) throw new LarkFailure({ kind: 'network', message: '断网' });
      return base.api.createMessage(input);
    },
  };
  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 30, sleep: async () => {} });

  const first = await channel.deliver({ deliveryId: 'dlv_mix', text: '甲'.repeat(70) });
  assert.equal(first.messagesSent, 1);

  const before = base.sent.length;
  const changed = await channel.deliver({ deliveryId: 'dlv_mix', text: '乙'.repeat(70) });
  assert.equal(changed.errorCode, 'other');
  assert.match(changed.error ?? '', /不一致/);
  assert.equal(base.sent.length, before);
});

test('交付：图片与文件先上传再发，图片消息带 image_key', async () => {
  const { api, sent, uploads } = fakeApi();
  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 2000 });

  await channel.deliver({
    deliveryId: 'dlv_media',
    text: '看这个',
    images: [{ bytes: new Uint8Array([1, 2, 3]), fileName: '截图.png' }],
    files: [{ bytes: new Uint8Array([4, 5]), fileName: '日志.txt' }],
  });

  assert.deepEqual(uploads, ['image:截图.png', 'file:日志.txt']);
  const imageMessage = sent.find((item) => item.msgType === 'image');
  assert.deepEqual(JSON.parse(imageMessage!.content), { image_key: 'img_key_1' });
  const fileMessage = sent.find((item) => item.msgType === 'file');
  assert.deepEqual(JSON.parse(fileMessage!.content), { file_key: 'file_key_1' });
});

test('交付：超过上传上限的文件在本地就拦下，换成 too-long', async () => {
  const { api, uploads } = fakeApi();
  const channel = new OutboundChannel({ api, chatId: 'oc_1', maxText: 2000 });

  const receipt = await channel.deliver({
    deliveryId: 'dlv_big',
    text: '',
    files: [{ bytes: new Uint8Array(30 * 1024 * 1024 + 1), fileName: '大文件.zip' }],
  });

  assert.equal(receipt.errorCode, 'too-long');
  assert.deepEqual(uploads, []);
});

test('幂等键：稳定、逐段不同、不超过平台 50 字符上限', () => {
  const first = idempotencyKey('dlv_abcdef', 0);
  assert.equal(first, idempotencyKey('dlv_abcdef', 0));
  assert.notEqual(first, idempotencyKey('dlv_abcdef', 1));
  assert.ok(first.length <= 50);
  assert.match(first, /^lark-[0-9a-f]+$/);
});

test('卡片兜底：字符没超但卡片字节超限时继续对半切', () => {
  const long = '汉'.repeat(12_000);
  const pieces = shrinkToCardLimit(long, (text) => ({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } }));

  assert.ok(pieces.length > 1);
  for (const piece of pieces) {
    const bytes = cardBytes({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: piece }] } });
    assert.ok(bytes <= 28 * 1024, `单卡 ${bytes} 字节`);
  }
  assert.equal(pieces.join(''), long);
});

test('文件类型：按扩展名推断，未知走 stream', () => {
  assert.equal(fileTypeOf('报告.PDF'), 'pdf');
  assert.equal(fileTypeOf('a.docx'), 'doc');
  assert.equal(fileTypeOf('b.xlsx'), 'xls');
  assert.equal(fileTypeOf('c.pptx'), 'ppt');
  assert.equal(fileTypeOf('d.mp4'), 'mp4');
  assert.equal(fileTypeOf('e.zip'), 'stream');
});
