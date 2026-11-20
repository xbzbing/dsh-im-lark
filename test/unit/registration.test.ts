import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppRegistration } from '../../src/host/registration.ts';
import type { RegistrationPorts } from '../../src/host/registration.ts';
import type { LarkCredentials } from '../../src/host/lark/types.ts';
import { fakeClock } from './helpers/temp.ts';

const AUTH_URL = 'https://accounts.feishu.cn/oauth/v1/app/registration?user_code=ABCD-EFGH';
const APP = { appId: 'cli_1234567890', appSecret: 'gwm-secret-value', domain: 'feishu' as const };

interface Pending {
  resolve(app: { appId: string; appSecret: string }): void;
  reject(error: unknown): void;
  signal: AbortSignal;
}

interface Harness {
  registration: AppRegistration;
  clock: ReturnType<typeof fakeClock>;
  saved: LarkCredentials[];
  reloads: number;
  starts: Array<{ domain: string; signal: AbortSignal }>;
  pending(): Pending;
}

/** 让状态机内部的 promise 链跑完；避免用真实计时器。 */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function harness(): Harness {
  const clock = fakeClock();
  const saved: LarkCredentials[] = [];
  const starts: Array<{ domain: string; signal: AbortSignal }> = [];
  let reloads = 0;
  let current: Pending | null = null;

  const ports: RegistrationPorts = {
    start(input) {
      starts.push({ domain: input.domain, signal: input.signal });
      input.onUrl({ url: AUTH_URL, expireIn: 600 });
      return new Promise((resolve, reject) => {
        current = { resolve, reject, signal: input.signal };
      });
    },
    async save(credentials) {
      saved.push(credentials);
    },
    async reload() {
      reloads += 1;
    },
    logger: {},
    now: clock.now,
  };

  return {
    registration: new AppRegistration(ports),
    clock,
    saved,
    get reloads() {
      return reloads;
    },
    starts,
    pending() {
      assert.ok(current !== null, 'start 还没被调用');
      return current;
    },
  } as Harness;
}

test('创建应用：start 拿到链接后进入 waiting，并带回二维码矩阵', async () => {
  const h = harness();
  const snapshot = await h.registration.start('feishu');

  assert.equal(snapshot.state, 'waiting');
  assert.equal(snapshot.url, AUTH_URL);
  assert.equal(snapshot.expiresAt, h.clock.now() + 600_000);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.appIdTail, null);
  assert.ok(snapshot.qr !== null, '应生成二维码矩阵');
  assert.equal(snapshot.qr.modules.length, snapshot.qr.size * snapshot.qr.size);
  assert.equal(h.starts[0]?.domain, 'feishu');
});

test('创建应用：授权成功后保存凭据、进入 done，只回尾号', async () => {
  const h = harness();
  await h.registration.start('feishu');
  h.pending().resolve(APP);
  await settle();

  const snapshot = h.registration.poll();
  assert.equal(snapshot.state, 'done');
  assert.equal(snapshot.appIdTail, '567890');
  assert.equal(snapshot.url, null);
  assert.equal(snapshot.expiresAt, null);
  assert.deepEqual(h.saved, [{ appId: APP.appId, appSecret: APP.appSecret, domain: 'feishu' }]);
  assert.equal(h.reloads, 1);

  // Secret 与完整 App ID 都不该出现在面板快照里。
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(APP.appSecret), false);
  assert.equal(serialized.includes(APP.appId), false);
});

test('创建应用：cancel 立即回到 idle 并中止底层授权', async () => {
  const h = harness();
  await h.registration.start('lark');

  const snapshot = h.registration.cancel();
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.url, null);
  assert.equal(h.starts[0]?.signal.aborted, true);
  await settle();
  assert.equal(h.registration.snapshot().state, 'idle');
  assert.equal(h.saved.length, 0);
});

test('创建应用：重复 start 会中止上一条授权', async () => {
  const h = harness();
  await h.registration.start('feishu');
  const first = h.starts[0]!.signal;

  const snapshot = await h.registration.start('lark');
  assert.equal(snapshot.state, 'waiting');
  assert.equal(h.starts.length, 2);
  assert.equal(first.aborted, true);
  assert.equal(h.starts[1]?.signal.aborted, false);
  await settle();
  assert.equal(h.registration.poll().state, 'waiting');
});

test('创建应用：链接过期后 poll 转 error，不再展示旧链接', async () => {
  const h = harness();
  await h.registration.start('feishu');

  h.clock.advance(600_000);
  const snapshot = h.registration.poll();
  assert.equal(snapshot.state, 'error');
  assert.match(snapshot.error ?? '', /过期/u);
  assert.equal(snapshot.url, null);
  assert.equal(snapshot.expiresAt, null);
  assert.equal(h.starts[0]?.signal.aborted, true);
});

test('创建应用：平台错误脱敏，不把原始 message 透给页面', async () => {
  const cases: Array<[string, RegExp]> = [
    ['access_denied: user said no', /授权被拒绝/u],
    ['network timeout /Users/ankh/secret appSecret=abc', /连接飞书开放平台失败/u],
    ['unexpected internal detail /tmp/foo', /创建应用失败/u],
  ];

  for (const [message, expected] of cases) {
    const clock = fakeClock();
    const ports: RegistrationPorts = {
      start: async () => {
        throw new Error(message);
      },
      save: async () => {},
      reload: async () => {},
      logger: {},
      now: clock.now,
    };
    const snapshot = await new AppRegistration(ports).start('feishu');
    assert.equal(snapshot.state, 'error');
    assert.match(snapshot.error ?? '', expected);
    assert.equal(snapshot.error?.includes('secret'), false);
    assert.equal(snapshot.error?.includes('/Users/'), false);
  }
});

test('创建应用：保存失败不进入 done，也不回 App ID 尾号', async () => {
  const clock = fakeClock();
  let release!: () => void;
  const ports: RegistrationPorts = {
    start: async (input) => {
      input.onUrl({ url: AUTH_URL, expireIn: 600 });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { appId: APP.appId, appSecret: APP.appSecret };
    },
    save: async () => {
      throw new Error('disk full /Users/ankh/.dsh');
    },
    reload: async () => {},
    logger: {},
    now: clock.now,
  };
  const registration = new AppRegistration(ports);
  const started = await registration.start('feishu');
  assert.equal(started.state, 'waiting');

  release();
  await settle();
  const snapshot = registration.poll();
  assert.equal(snapshot.state, 'error');
  assert.equal(snapshot.appIdTail, null);
  assert.equal(snapshot.error?.includes('/Users/'), false);
});

test('创建应用：重连失败不影响 done（凭据已经保存）', async () => {
  const clock = fakeClock();
  const warnings: unknown[][] = [];
  const ports: RegistrationPorts = {
    start: async (input) => {
      input.onUrl({ url: AUTH_URL, expireIn: 600 });
      return { appId: APP.appId, appSecret: APP.appSecret };
    },
    save: async () => {},
    reload: async () => {
      throw new Error('reconnect failed');
    },
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
    now: clock.now,
  };
  const registration = new AppRegistration(ports);
  await registration.start('feishu');
  await settle();

  assert.equal(registration.poll().state, 'done');
  assert.equal(warnings.length, 1);
});
