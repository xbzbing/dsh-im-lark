import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { test } from 'node:test';

import { apply, inject, name } from '../../index.ts';
import type { BridgeProvider } from '../../src/host/protocol.ts';
import { withTempDir } from './helpers/temp.ts';

/** 只实现本插件用到的宿主表面：effect / inject / on / logger / connection.rpc。 */
function fakeContext(services: Record<string, unknown> = {}) {
  const cleanups: Array<() => void> = [];
  const listeners: Array<string> = [];
  const cleanupsByService = new Map<string, Array<() => void>>();
  let rpcHandler: ((endpoint: string, payload: unknown) => Promise<unknown>) | null = null;

  const ctx = {
    logger: {},
    effect(work: () => () => void) {
      cleanups.push(work());
    },
    inject(servicesToInstall: string[], install: (scope: unknown) => void) {
      const scopeCleanups: Array<() => void> = [];
      const scope = {
        ...services,
        connection: ctx.connection,
        effect(work: () => () => void) {
          const cleanup = work();
          scopeCleanups.push(cleanup);
          cleanups.push(cleanup);
        },
      };
      install(scope);
      cleanupsByService.set(servicesToInstall.join(','), scopeCleanups);
    },
    on(event: string) {
      listeners.push(event);
      return () => {};
    },
    connection: {
      rpc: {
        handle(_channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>) {
          rpcHandler = handler;
          return () => {
            rpcHandler = null;
          };
        },
      },
    },
  };

  const callRpc = async (endpoint: string, payload?: unknown) => {
    assert.ok(rpcHandler !== null, '面板 RPC 未注册');
    return (await rpcHandler(endpoint, payload)) as { ok: boolean; value?: any; error?: any };
  };

  return { ctx, cleanups, listeners, callRpc };
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

test('入口：先开核心开关、后填凭据，桥会被重新注册；换凭据也不掉线', async () => {
  await withTempDir(async (dir) => {
    const registered: BridgeProvider[] = [];
    const disposed: string[] = [];

    const core = {
      protocol: { versions: ['my-superagent/v1'], features: ['owner-images'] },
      bridges: {
        register(provider: BridgeProvider) {
          registered.push(provider);
          return {
            id: `lark:${provider.account}`,
            protocol: 'my-superagent/v1',
            async receive() {
              return { accepted: true as const };
            },
            async answer() {
              return { accepted: true as const };
            },
            update() {},
            commands: () => [],
            isOwner: () => true,
            dispose() {
              disposed.push(provider.account);
            },
          };
        },
      },
    };

    const { ctx, callRpc } = fakeContext({ mySuperagent: core });
    // enabled=false：测试里不真的去建长连接；模式路由与连接无关。
    await apply(ctx as never, { dataDir: dir.path, enabled: false });

    // 1) 先打开核心开关：此时还没有桥，注册应当无动作。
    const toggled = await callRpc('settings.set', { superagent: true });
    assert.equal(toggled.ok, true, JSON.stringify(toggled.error));
    assert.equal(registered.length, 0);

    // 2) 后填凭据：建出 stack 后按当前模式注册。
    const saved = await callRpc('credentials.save', { appId: 'cli_0123456789', appSecret: 'secret-1' });
    assert.equal(saved.ok, true, JSON.stringify(saved.error));
    assert.equal(registered.length, 1);
    // 没有连接时健康度必须是 down，核心才不会继续排队。
    assert.equal(registered[0]!.health().state, 'down');

    // 3) 换凭据：旧句柄先销毁，新 stack 仍要注册（回归：以前会永久掉回独立模式）。
    const changed = await callRpc('credentials.save', { appId: 'cli_0123456789', appSecret: 'secret-2' });
    assert.equal(changed.ok, true, JSON.stringify(changed.error));
    assert.equal(registered.length, 2);
    assert.equal(disposed.length, 1);

    // 4) 关掉核心开关：注销；再打开：重新注册。
    await callRpc('settings.set', { superagent: false });
    assert.equal(disposed.length, 2);
    await callRpc('settings.set', { superagent: true });
    assert.equal(registered.length, 3);
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
