import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LarkFailure, retryDelayMs, toLarkFailure } from '../../src/host/lark/errors.ts';

test('错误分类：频控码与 429 都归到 rate-limited', () => {
  assert.equal(toLarkFailure({ code: 230020 }).kind, 'rate-limited');
  assert.equal(toLarkFailure({ code: 99991400 }).kind, 'rate-limited');
  assert.equal(toLarkFailure({ code: 0, response: { status: 429 } }).kind, 'rate-limited');
});

test('错误分类：凭据类错误归到 auth，且不可重试', () => {
  const failure = toLarkFailure({ code: 99991663 });
  assert.equal(failure.kind, 'auth');
  assert.equal(failure.retriable, false);
});

test('错误分类：超长与群权限错误不是可重试故障', () => {
  assert.equal(toLarkFailure({ code: 230025 }).kind, 'too-long');
  assert.equal(toLarkFailure({ code: 230018 }).kind, 'forbidden');
  assert.equal(toLarkFailure({ code: 230013 }).kind, 'recipient');
  assert.equal(toLarkFailure({ code: 230011 }).kind, 'gone');
  assert.equal(toLarkFailure({ code: 230025 }).retriable, false);
});

test('错误分类：网络类异常可重试', () => {
  assert.equal(toLarkFailure(new Error('socket hang up')).kind, 'network');
  assert.equal(toLarkFailure({ response: { status: 503 } }).kind, 'network');
  assert.equal(toLarkFailure(new Error('socket hang up')).retriable, true);
});

test('错误分类：认不出来的错误落到 other 且可重试一次', () => {
  const failure = toLarkFailure(new Error('something odd'));
  assert.equal(failure.kind, 'other');
  assert.equal(failure.retriable, true);
});

test('错误分类：从响应头读取频控等待时间', () => {
  const failure = toLarkFailure({
    response: { status: 429, headers: { 'x-ogw-ratelimit-reset': '7' }, data: { code: 99991400 } },
  });
  assert.equal(failure.kind, 'rate-limited');
  assert.equal(failure.retryAfterMs, 7_000);
});

test('退避：平台给了等待时间就用它（含 250ms 余量）', () => {
  const failure = new LarkFailure({ kind: 'rate-limited', retryAfterMs: 1_000 });
  assert.equal(retryDelayMs(failure, 1), 1_250);
});

test('退避：没有等待时间时按次数指数增长并封顶 30 秒', () => {
  const failure = new LarkFailure({ kind: 'network' });
  assert.equal(retryDelayMs(failure, 1), 1_000);
  assert.equal(retryDelayMs(failure, 2), 2_000);
  assert.equal(retryDelayMs(failure, 3), 4_000);
  assert.equal(retryDelayMs(failure, 99), 30_000);
});

test('退避：平台给的等待时间也受 30 秒上限约束', () => {
  const failure = new LarkFailure({ kind: 'rate-limited', retryAfterMs: 120_000 });
  assert.equal(retryDelayMs(failure, 1), 30_000);
});

test('未知抛出物（字符串、空值）也能分类，不会抛二次异常', () => {
  assert.equal(toLarkFailure('boom').kind, 'other');
  assert.equal(toLarkFailure(undefined).kind, 'other');
  assert.equal(toLarkFailure(null).kind, 'other');
});
