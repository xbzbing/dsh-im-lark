import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalConfigStore, normalizePluginConfig } from '../../src/host/config.ts';
import { ENDPOINTS, RPC_ENDPOINT, RPC_PATH, handleEndpoint, registerPanelRpc, snapshotOf } from '../../src/host/panel-host.ts';
import type { PanelDeps } from '../../src/host/panel-host.ts';
import { AppRegistration } from '../../src/host/registration.ts';
import { ReminderCenter } from '../../src/host/reminders.ts';
import type { LarkRuntime, RuntimeStatus } from '../../src/host/runtime.ts';
import { CredentialStore } from '../../src/host/state/credentials.ts';
import { Workspaces } from '../../src/host/workspaces.ts';
import { PANEL_CONTRACT } from '../../src/shared/version.ts';
import { withTempDir } from './helpers/temp.ts';

const APP = { appId: 'cli_aaaabbbbcccc', appSecret: 'yku-secret-value', domain: 'feishu' as const };

interface Harness {
  deps: PanelDeps;
  credentials: CredentialStore;
  settings: LocalConfigStore;
  calls: { reload: number; reconnect: number; applied: Record<string, unknown>[] };
  status: RuntimeStatus;
  registrations: string[];
}

async function harness(dir: string, options: { withCredentials?: boolean } = {}): Promise<Harness> {
  const config = normalizePluginConfig({ dataDir: dir });
  const credentials = new CredentialStore({ dataDir: dir });
  if (options.withCredentials !== false) await credentials.save(APP);
  const settings = new LocalConfigStore({ dataDir: dir, config });
  await settings.load();

  const calls = { reload: 0, reconnect: 0, applied: [] as Record<string, unknown>[] };
  const status: RuntimeStatus = {
    appIdTail: options.withCredentials === false ? null : 'bbcccc',
    domain: 'feishu',
    enabled: true,
    superagent: false,
    connection: { state: 'connected', since: 0, reconnectAttempts: 0 },
    coreAvailable: false,
  };

  const runtime = {
    status: () => status,
    async applySettings(patch: Record<string, unknown>) {
      calls.applied.push(patch);
      return { ...settings.current, ...patch };
    },
    async reloadCredentials() {
      calls.reload += 1;
    },
    async reconnect() {
      calls.reconnect += 1;
    },
    setCoreAvailable() {},
    get coreAvailable() {
      return false;
    },
  } as unknown as LarkRuntime;

  const registrations: string[] = [];
  const registration = new AppRegistration({
    start: async (input) => {
      registrations.push(input.domain);
      input.onUrl({ url: 'https://accounts.feishu.cn/oauth/v1/app/registration?user_code=TEST', expireIn: 600 });
      return await new Promise<never>(() => {});
    },
    save: async () => {},
    reload: async () => {},
    logger: {},
  });

  const workspaces = new Workspaces({ dir: `${dir}/workspace`, logger: {} });
  workspaces.attach({
    list: () => [{ id: 'ws-project', title: '项目 A', path: `${dir}/project` }],
    create: async () => ({ id: 'ws-default' }),
  });
  await workspaces.ensureDefault();
  const reminders = new ReminderCenter({
    send: async () => true,
    recipient: () => 'ou_owner',
    isActive: () => true,
    enabled: true,
    delayMinutes: 5,
    logger: {},
  });

  return {
    deps: { runtime, credentials, settings, config, registration, workspaces, reminders, logger: {} },
    credentials,
    settings,
    calls,
    status,
    registrations,
  };
}

test('面板：status 只回尾号，不回 Secret', async () => {
  await withTempDir(async (dir) => {
    const { deps } = await harness(dir.path);
    const snapshot = (await handleEndpoint(deps, ENDPOINTS.STATUS, {})) as Record<string, any>;

    assert.equal(snapshot.contract, PANEL_CONTRACT);
    assert.equal(snapshot.appIdTail, 'bbcccc');
    assert.equal(JSON.stringify(snapshot).includes(APP.appSecret), false);
    assert.equal(JSON.stringify(snapshot).includes(APP.appId), false);
    assert.equal(snapshot.settings.typingIndicator, true);
    assert.equal(snapshot.settings.questionReminders, true);
    assert.equal(snapshot.settings.questionDelayMinutes, 5);
    assert.equal(snapshot.settings.directBusyMode, 'steer');
    assert.equal(snapshot.settings.directWorkspaceId, '');
    assert.deepEqual(snapshot.reminders, { pendingQuestions: 0, pendingApprovals: 0 });
  });
});

test('面板：保存凭据后触发重连，且允许留空沿用旧 Secret', async () => {
  await withTempDir(async (dir) => {
    const { deps, credentials, calls } = await harness(dir.path);

    await handleEndpoint(deps, ENDPOINTS.CREDENTIALS_SAVE, {
      appId: 'cli_new_id_123456',
      appSecret: 'new-secret',
      domain: 'lark',
    });
    assert.equal(calls.reload, 1);
    assert.deepEqual(await credentials.load(), { appId: 'cli_new_id_123456', appSecret: 'new-secret', domain: 'lark' });

    // 只改域名：Secret 留空，沿用已保存的。
    await handleEndpoint(deps, ENDPOINTS.CREDENTIALS_SAVE, { appId: 'cli_new_id_123456', domain: 'feishu' });
    assert.deepEqual(await credentials.load(), { appId: 'cli_new_id_123456', appSecret: 'new-secret', domain: 'feishu' });
  });
});

test('面板：首次保存缺 Secret 时明确报错，不落半份凭据', async () => {
  await withTempDir(async (dir) => {
    const { deps, credentials } = await harness(dir.path, { withCredentials: false });
    await assert.rejects(
      handleEndpoint(deps, ENDPOINTS.CREDENTIALS_SAVE, { appId: 'cli_x' }),
      /App Secret 不能为空/,
    );
    assert.equal(await credentials.load(), null);
  });
});

test('面板：App ID 形状不对时拒绝保存', async () => {
  await withTempDir(async (dir) => {
    const { deps, credentials } = await harness(dir.path, { withCredentials: false });
    await assert.rejects(
      handleEndpoint(deps, ENDPOINTS.CREDENTIALS_SAVE, { appId: 'bad id!', appSecret: 'secret-1' }),
      /App ID 格式不正确/,
    );
    assert.equal(await credentials.load(), null);
  });
});

test('面板：清除凭据后状态回到未配置', async () => {
  await withTempDir(async (dir) => {
    const { deps, credentials, status } = await harness(dir.path);
    status.appIdTail = null;
    const snapshot = (await handleEndpoint(deps, ENDPOINTS.CREDENTIALS_CLEAR, {})) as Record<string, any>;

    assert.equal(await credentials.load(), null);
    assert.equal(snapshot.appIdTail, null);
  });
});

test('面板：自检用已保存的 Secret，结果原样回给页面', async () => {
  await withTempDir(async (dir) => {
    const { deps } = await harness(dir.path);
    const seen: unknown[] = [];
    deps.probe = async (input) => {
      seen.push(input.app);
      return { ok: true, botName: '小助手' };
    };

    const result = (await handleEndpoint(deps, ENDPOINTS.PROBE, {})) as { check: { ok: boolean; botName?: string } };
    assert.equal(result.check.ok, true);
    assert.deepEqual(seen, [APP]);
  });
});

test('面板：设置只接受白名单字段，越界整数被拒', async () => {
  await withTempDir(async (dir) => {
    const { deps, calls } = await harness(dir.path);

    await handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { typingIndicator: false, replyStatus: true });
    assert.deepEqual(calls.applied, [{ typingIndicator: false, replyStatus: true }]);

    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { questionDelayMinutes: 999 }), /0–120/);
    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { enabled: 'yes' }), /布尔值/);
    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, {}), /没有要保存的设置/);

    await handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { questionReminders: false, questionDelayMinutes: 0 });
    assert.deepEqual(calls.applied[1], { questionReminders: false, questionDelayMinutes: 0 });

    await handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { directBusyMode: 'queue' });
    assert.deepEqual(calls.applied[2], { directBusyMode: 'queue' });
    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { directBusyMode: 'later' }), /steer 或 queue/);
  });
});

test('面板：长程任务与失败提醒设置能保存，阈值越界被拒', async () => {
  await withTempDir(async (dir) => {
    const { deps, calls } = await harness(dir.path);

    await handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { longTaskReminders: false, failureReminders: false });
    assert.deepEqual(calls.applied[0], { longTaskReminders: false, failureReminders: false });

    await handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { longTaskMinutes: 90 });
    assert.deepEqual(calls.applied[1], { longTaskMinutes: 90 });

    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { longTaskMinutes: 0 }), /1–1440/);
    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { longTaskMinutes: 1441 }), /1–1440/);
    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { longTaskReminders: 'on' }), /布尔值/);
  });
});

test('面板：快照带上长程任务与失败提醒的当前值', async () => {
  await withTempDir(async (dir) => {
    const { deps } = await harness(dir.path);
    const snapshot = (await handleEndpoint(deps, ENDPOINTS.STATUS, {})) as {
      settings: { longTaskReminders: boolean; longTaskMinutes: number; failureReminders: boolean };
    };

    assert.equal(snapshot.settings.longTaskReminders, true);
    assert.equal(snapshot.settings.longTaskMinutes, 30);
    assert.equal(snapshot.settings.failureReminders, true);
  });
});

test('面板：工作区列表与选择校验', async () => {
  await withTempDir(async (dir) => {
    const { deps, calls } = await harness(dir.path);

    const catalog = (await handleEndpoint(deps, ENDPOINTS.WORKSPACES_LIST, {})) as Record<string, any>;
    assert.equal(catalog.available, true);
    assert.equal(catalog.defaultId, 'ws-default');
    assert.deepEqual(catalog.items.map((item: { id: string }) => item.id), ['ws-project']);

    await handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { directWorkspaceId: 'ws-default' });
    assert.deepEqual(calls.applied[0], { directWorkspaceId: '' });

    await handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { directWorkspaceId: 'ws-project' });
    assert.deepEqual(calls.applied[1], { directWorkspaceId: 'ws-project' });

    await assert.rejects(
      handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { directWorkspaceId: 'ws-missing' }),
      /工作区不存在/,
    );
  });
});

test('面板：未知端点与重连', async () => {
  await withTempDir(async (dir) => {
    const { deps, calls } = await harness(dir.path);
    await assert.rejects(handleEndpoint(deps, 'nope', {}), /未知的面板端点/);
    await handleEndpoint(deps, ENDPOINTS.RECONNECT, {});
    assert.equal(calls.reconnect, 1);
  });
});

test('面板：快照里的契约版本与共享常量一致', async () => {
  await withTempDir(async (dir) => {
    const { deps } = await harness(dir.path);
    assert.equal(snapshotOf(deps).contract, PANEL_CONTRACT);
    assert.equal(snapshotOf(deps).config.maxText, 2000);
  });
});

test('面板：扫码创建应用的 start/poll/cancel 三个端点', async () => {
  await withTempDir(async (dir) => {
    const { deps, registrations } = await harness(dir.path);

    const started = (await handleEndpoint(deps, ENDPOINTS.REGISTER_START, { domain: 'lark' })) as {
      registration: { state: string; url: string | null; qr: { size: number; modules: number[] } | null };
    };
    assert.deepEqual(registrations, ['lark']);
    assert.equal(started.registration.state, 'waiting');
    assert.match(started.registration.url ?? '', /accounts\.feishu\.cn/u);
    assert.ok(started.registration.qr !== null);
    assert.equal(started.registration.qr.modules.length, started.registration.qr.size ** 2);

    const polled = (await handleEndpoint(deps, ENDPOINTS.REGISTER_POLL, {})) as { registration: Record<string, unknown> };
    assert.equal(polled.registration.state, 'waiting');
    // 轮询不重复传二维码矩阵。
    assert.equal('qr' in polled.registration, false);

    const cancelled = (await handleEndpoint(deps, ENDPOINTS.REGISTER_CANCEL, {})) as {
      registration: { state: string };
    };
    assert.equal(cancelled.registration.state, 'idle');
  });
});

test('面板：register.start 缺省使用配置里的平台', async () => {
  await withTempDir(async (dir) => {
    const { deps, registrations } = await harness(dir.path);
    await handleEndpoint(deps, ENDPOINTS.REGISTER_START, {});
    assert.deepEqual(registrations, ['feishu']);
    await handleEndpoint(deps, ENDPOINTS.REGISTER_CANCEL, {});
  });
});

test('面板路由：POST /api/dsh-im-lark 按信封分发，非 POST 回 405，清理后摘掉', async () => {
  await withTempDir(async (dir) => {
    const { deps } = await harness(dir.path);
    const routes: any[] = [];
    let cleanup: (() => void) | undefined;
    const connection = {
      fetch: {
        register(route: unknown) {
          routes.push(route);
          return () => {};
        },
      },
    };
    const ctx: any = {
      logger: {},
      connection,
      effect(execute: () => () => void) {
        cleanup = execute();
      },
      inject(_services: string[], install: (scope: unknown) => void) {
        // 真实宿主把同一个 scope 交给 install：effect 也挂在这个 scope 上。
        install(ctx);
      },
    };

    registerPanelRpc(ctx, deps);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, RPC_PATH);
    assert.equal(RPC_PATH, '/api/dsh-im-lark');
    assert.deepEqual(routes[0].methods, ['POST']);
    assert.equal(RPC_ENDPOINT, 'dsh-im-lark');

    const call = async (envelope: unknown, init: RequestInit = {}) => {
      const request = new Request(`http://localhost${RPC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        ...init,
      });
      const response = await routes[0].fetch(request);
      return { status: response.status, body: (await response.json()) as any };
    };

    const okCall = await call({ type: 'client-request', rpcId: 'r1', method: RPC_ENDPOINT, payload: { method: 'status', payload: {} } });
    assert.equal(okCall.status, 200);
    assert.equal(okCall.body.type, 'server-response');
    assert.equal(okCall.body.rpcId, 'r1');
    assert.equal(okCall.body.result.ok, true);
    assert.equal(okCall.body.result.value.contract, PANEL_CONTRACT);

    const unknown = await call({ type: 'client-request', rpcId: 'r2', method: RPC_ENDPOINT, payload: { method: 'nope' } });
    assert.equal(unknown.body.result.ok, false);
    assert.equal(unknown.body.result.error.code, 'unknown-endpoint');

    const wrongChannel = await call({ type: 'client-request', rpcId: 'r3', method: 'other', payload: { method: 'status' } });
    assert.equal(wrongChannel.body.result.error.code, 'bad-request');

    const notJson = await (await routes[0].fetch(
      new Request(`http://localhost${RPC_PATH}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }),
    )).status;
    assert.equal(notJson, 415);

    const getStatus = await (await routes[0].fetch(new Request(`http://localhost${RPC_PATH}`, { method: 'GET' }))).status;
    assert.equal(getStatus, 405);

    cleanup?.();
    // 清理后旧路由闭包必须断开：再打一次应回 503，而不是继续分发。
    const after = await routes[0].fetch(
      new Request(`http://localhost${RPC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r4', method: RPC_ENDPOINT, payload: { method: 'status' } }),
      }),
    );
    assert.equal(after.status, 503);
  });
});
