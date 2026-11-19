import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { test } from 'node:test';

import { apply, inject, name } from '../../index.ts';
import { withTempDir } from './helpers/temp.ts';

/** 只实现本插件用到的宿主表面：effect / inject / on / logger。 */
function fakeContext() {
  const cleanups: Array<() => void> = [];
  const listeners: Array<string> = [];

  const ctx = {
    logger: {},
    effect(work: () => () => void) {
      cleanups.push(work());
    },
    inject(_services: string[], install: (scope: unknown) => void) {
      const scope = {
        effect(work: () => () => void) {
          cleanups.push(work());
        },
      };
      install(scope);
    },
    on(event: string) {
      listeners.push(event);
      return () => {};
    },
  };

  return { ctx, cleanups, listeners };
}

test('入口：名字与注入面固定（不把核心写成硬依赖）', () => {
  assert.equal(name, 'dsh-im-lark');
  assert.deepEqual(inject, []);
});

test('入口：没有凭据时加载成功、注册事件监听，清理不抛错', async () => {
  await withTempDir(async (dir) => {
    const { ctx, cleanups, listeners } = fakeContext();

    const result = await apply(ctx as never, { dataDir: dir.path });
    assert.equal(result, undefined, 'apply 必须返回 void，否则 Cordis 会当成 effect');
    assert.ok(cleanups.length > 0);
    assert.deepEqual(listeners, ['session/event']);

    // 状态目录按私密权限创建。
    const mode = (await stat(dir.path)).mode & 0o777;
    assert.equal(mode.toString(8), '700');

    // 停机清理按逆序/任意顺序执行都不应抛错。
    for (const cleanup of cleanups) assert.doesNotThrow(() => cleanup());
  });
});

test('入口：重复加载同一目录不互相破坏（热重载重叠期）', async () => {
  await withTempDir(async (dir) => {
    const first = fakeContext();
    await apply(first.ctx as never, { dataDir: dir.path });

    const second = fakeContext();
    await apply(second.ctx as never, { dataDir: dir.path });

    for (const cleanup of first.cleanups) assert.doesNotThrow(() => cleanup());
    for (const cleanup of second.cleanups) assert.doesNotThrow(() => cleanup());
  });
});
