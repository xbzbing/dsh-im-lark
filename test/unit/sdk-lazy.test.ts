import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const nodeRequire = createRequire(import.meta.url);

/** 当前进程里已经加载的 SDK 条目。 */
function loadedSdkEntries(): string[] {
  return Object.keys(nodeRequire.cache).filter((key) => key.includes('@larksuiteoapi/node-sdk'));
}

test('装配点：导入时不加载 SDK', async () => {
  await import('../../src/host/lark/sdk.ts');
  assert.deepEqual(loadedSdkEntries(), []);
});

test('装配点：首次真正用到时才加载 SDK', async () => {
  const { sdkFactories } = await import('../../src/host/lark/sdk.ts');
  assert.deepEqual(loadedSdkEntries(), [], '导入之后仍不该加载');

  const client = sdkFactories.createSdkClient({
    appId: 'cli_lazy_test',
    appSecret: 'test-secret',
    domain: 'feishu',
    // 不传 logger 会落回 SDK 的 console 实现，测试输出里会多一行 [info]。
    logger: {},
  });

  assert.equal(typeof client.im, 'object');
  assert.equal(loadedSdkEntries().length, 1, '用到的这一刻才加载，且只加载一次');
});
