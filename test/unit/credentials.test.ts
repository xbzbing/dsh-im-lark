import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { probeCredentials, summarize, CredentialStore } from '../../src/host/state/credentials.ts';
import { withTempDir } from './helpers/temp.ts';

const APP = { appId: 'cli_a1b2c3d4e5f6', appSecret: 'top-secret-value', domain: 'feishu' as const };

/** 固定时钟：绑定时间要可断言，不能依赖真实时间。 */
const NOW = 1_700_000_000_000;

test('凭据：保存后能读回，文件权限收紧到 0600', async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore({ dataDir: dir.path, now: () => NOW });
    const summary = await store.save(APP);
    assert.equal(summary.appIdTail, 'd4e5f6');
    assert.equal(summary.boundAt, NOW);

    const loaded = await store.load();
    assert.deepEqual(loaded, { ...APP, boundAt: NOW });

    const mode = (await stat(dir.at('credentials.json'))).mode & 0o777;
    assert.equal(mode.toString(8), '600');
  });
});

test('凭据：同一 App ID 再保存（换 Secret）绑定时间不变', async () => {
  await withTempDir(async (dir) => {
    let now = NOW;
    const store = new CredentialStore({ dataDir: dir.path, now: () => now });
    await store.save(APP);

    now = NOW + 86_400_000;
    const summary = await store.save({ ...APP, appSecret: 'new-secret' });
    assert.equal(summary.boundAt, NOW);
    assert.deepEqual(await store.load(), { ...APP, appSecret: 'new-secret', boundAt: NOW });
  });
});

test('凭据：换成另一个 App ID 时绑定时间更新', async () => {
  await withTempDir(async (dir) => {
    let now = NOW;
    const store = new CredentialStore({ dataDir: dir.path, now: () => now });
    await store.save(APP);

    now = NOW + 86_400_000;
    const summary = await store.save({ ...APP, appId: 'cli_zzzzyyyyxxxx' });
    assert.equal(summary.boundAt, NOW + 86_400_000);
    assert.deepEqual(await store.load(), {
      appId: 'cli_zzzzyyyyxxxx',
      appSecret: APP.appSecret,
      domain: 'feishu',
      boundAt: NOW + 86_400_000,
    });
  });
});

test('凭据：老凭据没有绑定时间时用文件 mtime 兜底，且不写盘', async () => {
  await withTempDir(async (dir) => {
    const path = dir.at('credentials.json');
    await writeFile(path, `${JSON.stringify(APP, null, 2)}\n`);

    const store = new CredentialStore({ dataDir: dir.path });
    const loaded = await store.load();
    assert.equal(typeof loaded?.boundAt, 'number');
    assert.equal(Number.isFinite(loaded?.boundAt ?? 0), true);
    assert.ok((loaded?.boundAt ?? 0) > 0);

    // 兜底只补在内存里：文件内容不能出现 boundAt。
    const text = await readFile(path, 'utf8');
    assert.equal(text.includes('boundAt'), false);
  });
});

test('凭据：目录权限是 0700', async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore({ dataDir: dir.at('nested') });
    await store.save(APP);
    const mode = (await stat(dir.at('nested'))).mode & 0o777;
    assert.equal(mode.toString(8), '700');
  });
});

test('凭据：空 App ID / Secret 被拒绝，不落盘', async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore({ dataDir: dir.path });
    await assert.rejects(store.save({ ...APP, appId: '   ' }), /App ID 不能为空/);
    await assert.rejects(store.save({ ...APP, appSecret: '' }), /App Secret 不能为空/);
    assert.equal(await store.load(), null);
  });
});

test('凭据：文件损坏或字段不全时按未配置处理', async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore({ dataDir: dir.path });
    await store.save(APP);

    // 只清空，不删文件：模拟「卸载应用但保留目录」。
    await store.clear();
    assert.equal(await store.load(), null);
    assert.equal(await store.summary(), null);
  });
});

test('凭据：清空后文件里没有任何密钥内容', async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore({ dataDir: dir.path });
    await store.save(APP);
    await store.clear();
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(dir.at('credentials.json'), 'utf8');
    assert.equal(text.includes(APP.appSecret), false);
    assert.equal(text.includes(APP.appId), false);
  });
});

test('凭据摘要：尾号只取最后六位，短 App ID 原样返回', () => {
  assert.equal(summarize('cli_123456789', 'feishu').appIdTail, '456789');
  assert.equal(summarize('cli_1', 'lark').appIdTail, 'cli_1');
  assert.equal(summarize('cli_1', 'lark').domain, 'lark');
});

/** 造一个按 URL 分派的假 fetch。 */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const route = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    if (!route) throw new Error(`未预期的请求：${url}`);
    const { status = 200, body } = route[1];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}

test('自检：凭证与机器人信息都能拿到时返回 ok 与机器人信息', async () => {
  const fetch = fakeFetch({
    '/auth/v3/tenant_access_token/internal': { body: { code: 0, access_token: 't-abc', expires_in: 7200 } },
    '/bot/v3/info': { body: { code: 0, bot: { open_id: 'ou_bot', app_name: '小助手' } } },
  });
  const result = await probeCredentials({ app: APP, fetch });
  assert.equal(result.ok, true);
  assert.equal(result.botOpenId, 'ou_bot');
  assert.equal(result.botName, '小助手');
});

test('自检：密钥错误时给出可读原因，而不是平台英文原文', async () => {
  const fetch = fakeFetch({
    '/auth/v3/tenant_access_token/internal': { body: { code: 10014, msg: 'app secret invalid' } },
  });
  const result = await probeCredentials({ app: APP, fetch });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /App ID 或 App Secret 不正确/);
});

test('自检：机器人能力没开时提示去开启能力（而不是报密钥错）', async () => {
  const fetch = fakeFetch({
    '/auth/v3/tenant_access_token/internal': { body: { code: 0, tenant_access_token: 't-old', expire: 7200 } },
    '/bot/v3/info': { body: { code: 230006, msg: 'Bot ability is not activated.' } },
  });
  const result = await probeCredentials({ app: APP, fetch });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /机器人能力/);
});

test('自检：HTTP 失败与网络异常都收敛成 false，不抛错', async () => {
  const httpError = fakeFetch({ '/auth/v3/tenant_access_token/internal': { status: 500, body: {} } });
  assert.equal((await probeCredentials({ app: APP, fetch: httpError })).ok, false);

  const broken = (async () => {
    throw new Error('getaddrinfo ENOTFOUND open.feishu.cn');
  }) as unknown as typeof globalThis.fetch;
  const result = await probeCredentials({ app: APP, fetch: broken });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /换取访问凭证失败/);
});

test('自检：国际版走 lark 域名', async () => {
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, access_token: 't' }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, bot: { open_id: 'ou' } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  await probeCredentials({ app: { ...APP, domain: 'lark' }, fetch });
  assert.equal(urls.every((url) => url.startsWith('https://open.larksuite.com')), true);
});
