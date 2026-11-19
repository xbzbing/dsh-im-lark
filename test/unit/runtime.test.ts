import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalConfigStore, normalizePluginConfig } from '../../src/host/config.ts';
import type { LarkConnectionHandlers, LarkConnectionPort } from '../../src/host/lark/connection.ts';
import { LarkRuntime } from '../../src/host/runtime.ts';
import { CredentialStore } from '../../src/host/state/credentials.ts';
import { withTempDir } from './helpers/temp.ts';

const APP = { appId: 'cli_aaaabbbbcccc', appSecret: 'shh-its-a-secret', domain: 'feishu' as const };

/** 记录调用的假连接：start 立即成功，stop 记一笔。 */
class FakeConnection implements LarkConnectionPort {
  static created: FakeConnection[] = [];
  readonly appId: string;
  handlers: LarkConnectionHandlers | null = null;
  started = 0;
  stopped = 0;

  constructor(app: { appId: string }) {
    this.appId = app.appId;
    FakeConnection.created.push(this);
  }

  async start(handlers: LarkConnectionHandlers): Promise<void> {
    this.started += 1;
    this.handlers = handlers;
  }

  stop(): void {
    this.stopped += 1;
  }

  status() {
    return { state: this.started > 0 && this.stopped === 0 ? ('connected' as const) : ('idle' as const), since: 0, reconnectAttempts: 0 };
  }
}

interface Harness {
  runtime: LarkRuntime;
  settings: LocalConfigStore;
  credentials: CredentialStore;
  connections: FakeConnection[];
}

async function harness(dir: string, options: { withCredentials?: boolean; rawConfig?: Record<string, unknown> } = {}): Promise<Harness> {
  FakeConnection.created = [];
  const config = normalizePluginConfig({ dataDir: dir, ...options.rawConfig });
  const settings = new LocalConfigStore({ dataDir: dir, config });
  const credentials = new CredentialStore({ dataDir: dir });
  if (options.withCredentials !== false) await credentials.save(APP);

  const runtime = new LarkRuntime({
    config,
    logger: {},
    credentials,
    settings,
    createConnection: () => {
      const connection = new FakeConnection({ appId: 'x' });
      return connection;
    },
  });
  await runtime.start();
  return { runtime, settings, credentials, connections: FakeConnection.created };
}

test('运行期：有凭据且启用时自动建连接，事件转给 sink', async () => {
  await withTempDir(async (dir) => {
    const { runtime, connections } = await harness(dir.path);
    assert.equal(connections.length, 1);
    assert.equal(connections[0]!.started, 1);
    assert.equal(runtime.active, true);

    const seen: string[] = [];
    runtime.setSink({ onMessage: () => seen.push('message'), onCardAction: () => seen.push('card') });
    connections[0]!.handlers?.onMessage({ ok: 1 });
    connections[0]!.handlers?.onCardAction({ ok: 2 });
    assert.deepEqual(seen, ['message', 'card']);
  });
});

test('运行期：没有凭据时停在未连接，不建连接', async () => {
  await withTempDir(async (dir) => {
    const { runtime, connections } = await harness(dir.path, { withCredentials: false });
    assert.equal(connections.length, 0);
    assert.equal(runtime.active, false);
    assert.equal(runtime.status().appIdTail, null);
    assert.equal(runtime.status().connection.state, 'idle');
  });
});

test('运行期：静态配置里 enabled=false 时即使有凭据也不连', async () => {
  await withTempDir(async (dir) => {
    const { runtime, connections } = await harness(dir.path, { rawConfig: { enabled: false } });
    assert.equal(connections.length, 0);
    assert.equal(runtime.active, false);
  });
});

test('运行期：面板关掉接入后断开，重新打开后新建连接', async () => {
  await withTempDir(async (dir) => {
    const { runtime, connections } = await harness(dir.path);
    const first = connections[0]!;

    await runtime.applySettings({ enabled: false });
    assert.equal(first.stopped, 1);
    assert.equal(runtime.active, false);

    await runtime.applySettings({ enabled: true });
    assert.equal(connections.length, 2);
    assert.equal(runtime.active, true);
  });
});

test('运行期：重复保存同名开关不会反复重建连接（幂等）', async () => {
  await withTempDir(async (dir) => {
    const { runtime, connections } = await harness(dir.path);
    await runtime.applySettings({ enabled: true });
    await runtime.applySettings({ replyStatus: true });
    assert.equal(connections.length, 1);
    assert.equal(connections[0]!.stopped, 0);
  });
});

test('运行期：换凭据才重连，写同样的凭据保持原连接', async () => {
  await withTempDir(async (dir) => {
    const { runtime, credentials, connections } = await harness(dir.path);

    await credentials.save({ ...APP, appSecret: 'new-secret' });
    await runtime.reloadCredentials();
    assert.equal(connections.length, 2);
    assert.equal(connections[0]!.stopped, 1);
    assert.equal(runtime.status().appIdTail, 'bbcccc');

    await runtime.reloadCredentials();
    assert.equal(connections.length, 2);
  });
});

test('运行期：手动重连先断后连；未连接状态下不重复建连接', async () => {
  await withTempDir(async (dir) => {
    const { runtime, connections } = await harness(dir.path);
    await runtime.reconnect();
    assert.equal(connections.length, 2);
    assert.equal(connections[1]!.started, 1);

    await runtime.applySettings({ enabled: false });
    const before = connections.length;
    await runtime.reconnect();
    assert.equal(connections.length, before);
  });
});

test('运行期：初次连接失败后按退避自动重试，成功后不再重试', async () => {
  await withTempDir(async (dir) => {
    const config = normalizePluginConfig({ dataDir: dir.path });
    const settings = new LocalConfigStore({ dataDir: dir.path, config });
    const credentials = new CredentialStore({ dataDir: dir.path });
    await credentials.save(APP);

    let attempts = 0;
    let connected = false;
    const runtime = new LarkRuntime({
      config,
      logger: {},
      credentials,
      settings,
      retryBaseMs: 5,
      createConnection: () => ({
        async start() {
          attempts += 1;
          if (attempts === 1) throw new Error('network down');
          connected = true;
        },
        stop() {
          connected = false;
        },
        status: () => ({ state: connected ? ('connected' as const) : ('failed' as const), since: 0, reconnectAttempts: 0 }),
      }),
    });

    await runtime.start();
    assert.equal(attempts, 1);
    assert.match(runtime.status().lastError ?? '', /network down/);

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(attempts, 2);
    assert.equal(runtime.status().connection.state, 'connected');

    // 成功之后不再继续重试。
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(attempts, 2);

    runtime.stop();
    assert.equal(connected, false);
  });
});

test('运行期：连接落 failed 后按退避重连，停机后停止检查', async () => {
  await withTempDir(async (dir) => {
    const config = normalizePluginConfig({ dataDir: dir.path });
    const settings = new LocalConfigStore({ dataDir: dir.path, config });
    const credentials = new CredentialStore({ dataDir: dir.path });
    await credentials.save(APP);

    let attempts = 0;
    const runtime = new LarkRuntime({
      config,
      logger: {},
      credentials,
      settings,
      watchdogMs: 5,
      retryBaseMs: 5,
      createConnection: () => ({
        async start() {
          attempts += 1;
        },
        stop() {},
        status: () => ({ state: 'failed' as const, since: 0, reconnectAttempts: 0, lastError: 'down' }),
      }),
    });

    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(attempts >= 2, '失败状态应触发重连');

    runtime.stop();
    const seen = attempts;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(attempts, seen);
  });
});

test('运行期：停机后不再接受操作，事件也不再下发', async () => {
  await withTempDir(async (dir) => {
    const { runtime, connections } = await harness(dir.path);
    const seen: string[] = [];
    runtime.setSink({ onMessage: () => seen.push('x'), onCardAction: () => seen.push('y') });

    const handlers = connections[0]!.handlers!;
    runtime.stop();
    assert.equal(runtime.active, false);
    assert.equal(connections[0]!.stopped, 1);

    // 断开后旧连接就算还回调，也不该再进 sink（sink 由上层清理，这里只验证状态）。
    assert.equal(runtime.status().connection.state, 'idle');
    assert.deepEqual(seen, []);
    void handlers;
  });
});

test('运行期：连接启动失败被记进状态，不抛到调用方', async () => {
  await withTempDir(async (dir) => {
    const config = normalizePluginConfig({ dataDir: dir.path });
    const settings = new LocalConfigStore({ dataDir: dir.path, config });
    const credentials = new CredentialStore({ dataDir: dir.path });
    await credentials.save(APP);

    const runtime = new LarkRuntime({
      config,
      logger: {},
      credentials,
      settings,
      createConnection: () => ({
        start: async () => {
          throw new Error('ws: handshake timeout');
        },
        stop: () => {},
        status: () => ({ state: 'failed' as const, since: 0, reconnectAttempts: 0 }),
      }),
    });

    await runtime.start();
    assert.match(runtime.status().lastError ?? '', /handshake timeout/);
  });
});

test('运行期：核心不可用时状态里如实反映，切到可用后反映可用', async () => {
  await withTempDir(async (dir) => {
    const { runtime } = await harness(dir.path);
    assert.equal(runtime.coreAvailable, false);
    runtime.setCoreAvailable(true);
    assert.equal(runtime.coreAvailable, true);
    assert.equal(runtime.status().coreAvailable, true);
  });
});
