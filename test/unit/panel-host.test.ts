import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalConfigStore, normalizePluginConfig } from '../../src/host/config.ts';
import { ENDPOINTS, handleEndpoint, snapshotOf } from '../../src/host/panel-host.ts';
import type { PanelDeps } from '../../src/host/panel-host.ts';
import type { LarkRuntime, RuntimeStatus } from '../../src/host/runtime.ts';
import { CredentialStore } from '../../src/host/state/credentials.ts';
import { PANEL_CONTRACT } from '../../src/shared/version.ts';
import { withTempDir } from './helpers/temp.ts';

const APP = { appId: 'cli_aaaabbbbcccc', appSecret: 'yku-secret-value', domain: 'feishu' as const };

interface Harness {
  deps: PanelDeps;
  credentials: CredentialStore;
  settings: LocalConfigStore;
  calls: { reload: number; reconnect: number; applied: Record<string, unknown>[] };
  status: RuntimeStatus;
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

  return {
    deps: { runtime, credentials, settings, config, logger: {} },
    credentials,
    settings,
    calls,
    status,
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
    assert.equal('questionReminders' in snapshot.settings, false);
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

    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { questionDelayMinutes: 999 }), /没有要保存的设置/);
    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, { enabled: 'yes' }), /布尔值/);
    await assert.rejects(handleEndpoint(deps, ENDPOINTS.SETTINGS_SET, {}), /没有要保存的设置/);
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
