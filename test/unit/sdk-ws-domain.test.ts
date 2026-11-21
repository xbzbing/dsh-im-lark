import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeWsParams } from '../../src/host/lark/sdk.ts';

test('长连接参数：抽象域转成 SDK 认识的地址', () => {
  assert.equal(normalizeWsParams({ domain: 'feishu' }).domain, 'https://open.feishu.cn');
  assert.equal(normalizeWsParams({ domain: 'lark' }).domain, 'https://open.larksuite.com');
});

test('长连接参数：已经是地址或没给 domain 时原样透传', () => {
  const custom = { domain: 'https://example.com' };
  assert.equal(normalizeWsParams(custom), custom);
  const none = { appId: 'cli_test' };
  assert.equal(normalizeWsParams(none), none);
});
