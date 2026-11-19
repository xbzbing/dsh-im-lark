import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PANEL_CONTRACT, RPC_CHANNEL } from '../../src/client/constants.ts';
import { createRpcCall, dotOf, errorText, isContractMismatch, unwrapResult, validateMinutes } from '../../src/client/logic.ts';
import { fallbackTranslate } from '../../src/client/locales.ts';
import { PANEL_CONTRACT as HOST_CONTRACT, RPC_CHANNEL as HOST_CHANNEL } from '../../src/shared/version.ts';

test('面板契约：两半的通道名与契约版本一致', () => {
  assert.equal(RPC_CHANNEL, HOST_CHANNEL);
  assert.equal(PANEL_CONTRACT, HOST_CONTRACT);
});

test('RPC 信封：新宿主的 {ok, value} 与旧宿主的 {result} 都认', () => {
  assert.deepEqual(unwrapResult({ ok: true, value: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapResult({ result: { ok: true, value: 2 } }), 2);
});

test('RPC 信封：失败时带上 code 与可读文案', () => {
  assert.throws(
    () => unwrapResult({ ok: false, error: { code: 'invalid-config', message: 'App ID 不能为空', details: {} } }),
    (error: any) => error.code === 'invalid-config' && /App ID/.test(error.message),
  );
  assert.throws(() => unwrapResult('nope'), (error: any) => error.code === 'invalid-response');
});

test('RPC 调用：走约定的逻辑通道与端点；没有连接时给出可操作错误', async () => {
  const calls: unknown[][] = [];
  const rpcCall = createRpcCall({
    rpc: {
      async call(...args: unknown[]) {
        calls.push(args);
        return { ok: true, value: { contract: 1 } };
      },
    },
  });

  const value = await rpcCall('status', {});
  assert.deepEqual(value, { contract: 1 });
  assert.equal(calls[0]![0], RPC_CHANNEL);
  assert.equal(calls[0]![1], 'status');

  await assert.rejects(createRpcCall(undefined)('status'), (error: any) => error.code === 'connection-unavailable');
});

test('错误文案：连接类错误换成提示，其余保留宿主原文', () => {
  assert.match(errorText(fallbackTranslate, { code: 'connection-unavailable', message: '' }), /刷新页面/);
  assert.equal(errorText(fallbackTranslate, new Error('App Secret 不正确')), 'App Secret 不正确');
  assert.equal(errorText(fallbackTranslate, new Error('')), fallbackTranslate('error.generic'));
});

test('分钟校验：只接受区间内的整数，空串交给上层判定', () => {
  assert.equal(validateMinutes('45', 1, 1440), null);
  assert.equal(validateMinutes('0', 0, 120), null);
  assert.equal(validateMinutes('1441', 1, 1440), '请输入 1–1440 的整数');
  assert.equal(validateMinutes('1.5', 1, 1440), '请输入 1–1440 的整数');
  assert.equal(validateMinutes('', 1, 1440), null);
});

test('契约版本：对不上就提示重启', () => {
  assert.equal(isContractMismatch({ contract: PANEL_CONTRACT }), false);
  assert.equal(isContractMismatch({ contract: PANEL_CONTRACT - 1 }), true);
  assert.equal(isContractMismatch(null), false);
  assert.equal(isContractMismatch({}), false);
});

test('状态点：连接状态映射到宿主的语义', () => {
  assert.equal(dotOf('connected'), 'done');
  assert.equal(dotOf('connecting'), 'ongoing');
  assert.equal(dotOf('reconnecting'), 'ongoing');
  assert.equal(dotOf('failed'), 'error');
  assert.equal(dotOf('idle'), 'idle');
});

test('文案兜底：没有宿主文案服务时显示中文并插值', () => {
  assert.equal(fallbackTranslate('panel.title'), '飞书机器人');
  assert.equal(fallbackTranslate('credentials.probeOk', { name: '小助手' }), '自检通过：小助手');
});
