import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppRegistration } from '../../src/host/registration.ts';
import type { RegistrationPorts } from '../../src/host/registration.ts';

/**
 * 官方 SDK 的授权错误是普通对象 `{ code, description }`，不是 Error；abort 也一样。
 * 这里锁住「对象错误也能映射」与「原始描述不外泄」两条。
 */
function failing(error: unknown): AppRegistration {
  const ports: RegistrationPorts = {
    start: async () => {
      throw error;
    },
    save: async () => {},
    reload: async () => {},
    logger: {},
  };
  return new AppRegistration(ports);
}

test('创建应用：SDK 的普通对象错误也能映射成可读文案', async () => {
  const denied = await failing({ code: 'access_denied', description: 'user denied' }).start('feishu');
  assert.equal(denied.state, 'error');
  assert.match(denied.error ?? '', /授权被拒绝/u);

  const expired = await failing({ code: 'expired_token', description: 'expired' }).start('feishu');
  assert.equal(expired.state, 'error');
  assert.match(expired.error ?? '', /过期/u);
});

test('创建应用：普通对象里的原始描述不透给页面', async () => {
  const snapshot = await failing({ code: 'server_error', description: '/Users/ankh/secret appSecret=abc' }).start('feishu');
  assert.equal(snapshot.state, 'error');
  assert.equal(snapshot.error, '创建应用失败，请重试');
});
