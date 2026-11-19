import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMessageEvent, stripMentions } from '../../src/host/inbound.ts';

interface MessageInput {
  messageId?: string;
  chatId?: string;
  chatType?: 'p2p' | 'group';
  messageType?: string;
  content?: string;
  createTime?: string;
  parentId?: string;
  rootId?: string;
  senderType?: 'user' | 'app';
  senderOpenId?: string;
  mentions?: unknown[];
}

/** 造一条 `im.message.receive_v1` 事件：形状与平台一致，省略无关字段。 */
function event(input: MessageInput = {}): unknown {
  return {
    schema: '2.0',
    header: { event_id: 'ev_1', event_type: 'im.message.receive_v1', create_time: '1760000000000' },
    event: {
      sender: {
        sender_id: { open_id: input.senderOpenId ?? 'ou_user' },
        sender_type: input.senderType ?? 'user',
      },
      message: {
        message_id: input.messageId ?? 'om_1',
        chat_id: input.chatId ?? 'oc_1',
        chat_type: input.chatType ?? 'p2p',
        message_type: input.messageType ?? 'text',
        content: input.content ?? JSON.stringify({ text: '你好' }),
        create_time: input.createTime ?? '1760000000123',
        ...(input.parentId ? { parent_id: input.parentId } : {}),
        ...(input.rootId ? { root_id: input.rootId } : {}),
        ...(input.mentions ? { mentions: input.mentions } : {}),
      },
    },
  };
}

test('入站：单聊文本解析出消息 id、会话与时间', () => {
  const parsed = parseMessageEvent(event({ content: JSON.stringify({ text: '帮我看看这个报错' }) }));
  assert.equal(parsed.kind, 'message');
  if (parsed.kind !== 'message') return;

  assert.equal(parsed.message.messageId, 'om_1');
  assert.equal(parsed.message.chatId, 'oc_1');
  assert.equal(parsed.message.chatType, 'p2p');
  assert.equal(parsed.message.messageType, 'text');
  assert.equal(parsed.message.senderOpenId, 'ou_user');
  assert.equal(parsed.message.createTime, 1760000000123);
  assert.equal(parsed.body.text, '帮我看看这个报错');
  assert.deepEqual(parsed.body.images, []);
});

test('入站：引用回复带回 parent_id 与 root_id', () => {
  const parsed = parseMessageEvent(event({ parentId: 'om_parent', rootId: 'om_root' }));
  assert.equal(parsed.kind, 'message');
  if (parsed.kind !== 'message') return;
  assert.equal(parsed.message.parentId, 'om_parent');
  assert.equal(parsed.message.rootId, 'om_root');
});

test('入站：机器人自己发的消息被忽略（防止自激）', () => {
  const parsed = parseMessageEvent(event({ senderType: 'app' }));
  assert.equal(parsed.kind, 'ignored');
  if (parsed.kind === 'ignored') assert.match(parsed.reason, /机器人/);
});

test('入站：群消息没有 @机器人 时忽略', () => {
  const parsed = parseMessageEvent(event({ chatType: 'group', mentions: [] }));
  assert.equal(parsed.kind, 'ignored');
  if (parsed.kind === 'ignored') assert.match(parsed.reason, /@机器人/);
});

test('入站：@机器人 被删掉，@别人 还原成名字', () => {
  const mentions = [
    { key: '@_user_1', id: { open_id: 'ou_bot' }, name: '小助手', mentioned_type: 'bot' },
    { key: '@_user_2', id: { open_id: 'ou_alice' }, name: 'Alice' },
  ];
  const parsed = parseMessageEvent(
    event({
      chatType: 'group',
      mentions,
      content: JSON.stringify({ text: '@_user_1 让 @_user_2 看下这个 PR' }),
    }),
    { botOpenId: 'ou_bot' },
  );

  assert.equal(parsed.kind, 'message');
  if (parsed.kind !== 'message') return;
  assert.equal(parsed.body.text, '让 @Alice 看下这个 PR');
  assert.deepEqual(parsed.message.mentions, [
    { key: '@_user_1', name: '小助手', openId: 'ou_bot', isBot: true },
    { key: '@_user_2', name: 'Alice', openId: 'ou_alice' },
  ]);
});

test('入站：不知道机器人 open_id 时按 @ 触发语义删掉占位符', () => {
  assert.equal(
    stripMentions('@_user_1 你好', [{ key: '@_user_1', openId: 'ou_x', name: 'X' }]),
    '你好',
  );
});

test('入站：@所有人 占位符也不会留在正文里', () => {
  assert.equal(stripMentions('@_all 下午三点开会', []), '下午三点开会');
});

test('入站：富文本按阅读顺序拍平，图片与代码块都在', () => {
  const content = JSON.stringify({
    title: '周报',
    content: [
      [
        { tag: 'text', text: '本周完成：' },
        { tag: 'a', text: '看板', href: 'https://example.com/board' },
        { tag: 'at', user_id: 'ou_alice', user_name: 'Alice' },
      ],
      [{ tag: 'text', text: '关键实现：' }, { tag: 'code_block', language: 'ts', text: 'const a = 1;' }],
      [{ tag: 'img', image_key: 'img_v3_abc' }],
    ],
  });
  const parsed = parseMessageEvent(event({ messageType: 'post', content }), { botOpenId: 'ou_bot' });

  assert.equal(parsed.kind, 'message');
  if (parsed.kind !== 'message') return;
  assert.match(parsed.body.text, /^周报\n本周完成：\[看板\]\(https:\/\/example\.com\/board\)@Alice/);
  assert.match(parsed.body.text, /```ts\nconst a = 1;\n```/);
  assert.deepEqual(parsed.body.images, [{ imageKey: 'img_v3_abc' }]);
});

test('入站：富文本按语言容器取中文，取不到用英文', () => {
  const content = JSON.stringify({
    en_us: { title: 'Weekly', content: [[{ tag: 'text', text: 'done' }]] },
    zh_cn: { title: '周报', content: [[{ tag: 'text', text: '完成' }]] },
  });
  const parsed = parseMessageEvent(event({ messageType: 'post', content }));
  assert.equal(parsed.kind, 'message');
  if (parsed.kind !== 'message') return;
  assert.equal(parsed.body.text, '周报\n完成');
});

test('入站：图片与文件消息只提取 key，不在这里下载', () => {
  const image = parseMessageEvent(event({ messageType: 'image', content: JSON.stringify({ image_key: 'img_1' }) }));
  assert.equal(image.kind, 'message');
  if (image.kind === 'message') {
    assert.deepEqual(image.body.images, [{ imageKey: 'img_1' }]);
    assert.equal(image.body.text, '');
  }

  const file = parseMessageEvent(
    event({ messageType: 'file', content: JSON.stringify({ file_key: 'file_1', file_name: '日志.txt' }) }),
  );
  assert.equal(file.kind, 'message');
  if (file.kind === 'message') {
    assert.deepEqual(file.body.files, [{ fileKey: 'file_1', fileName: '日志.txt' }]);
    assert.equal(file.body.unsupported, undefined);
  }
});

test('入站：暂不支持的类型标成 unsupported，正文为空而不是乱码', () => {
  for (const type of ['audio', 'media', 'sticker', 'merge_forward']) {
    const parsed = parseMessageEvent(event({ messageType: type, content: '{}' }));
    assert.equal(parsed.kind, 'message');
    if (parsed.kind !== 'message') continue;
    assert.equal(parsed.body.unsupported, type);
    assert.equal(parsed.body.text, '');
  }
});

test('入站：content 不是合法 JSON 时降级为空正文，不让整条消息消失', () => {
  const parsed = parseMessageEvent(event({ content: '{ 坏掉的 JSON' }));
  assert.equal(parsed.kind, 'message');
  if (parsed.kind !== 'message') return;
  assert.equal(parsed.body.text, '');
  assert.equal(parsed.message.messageType, 'text');
});

test('入站：缺少 message_id 的事件被忽略', () => {
  const parsed = parseMessageEvent({ header: {}, event: { message: { chat_id: 'oc_1' } } });
  assert.equal(parsed.kind, 'ignored');
});

test('入站：完全不是事件对象也不抛错', () => {
  for (const raw of [null, undefined, 'x', 42, {}]) {
    assert.doesNotThrow(() => parseMessageEvent(raw));
    assert.equal(parseMessageEvent(raw).kind, 'ignored');
  }
});
