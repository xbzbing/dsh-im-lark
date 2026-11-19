import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RateGate } from '../../src/host/rate-limit.ts';
import { SeenStore } from '../../src/host/state/seen.ts';

test('去重：第一次见到返回 true，重复返回 false', () => {
  const store = new SeenStore({ now: () => 1_000 });
  assert.equal(store.claim('oc_1:om_1'), true);
  assert.equal(store.claim('oc_1:om_1'), false);
  assert.equal(store.claim('oc_1:om_2'), true);
  assert.equal(store.size, 2);
});

test('去重：不同会话里相同 message_id 不算重复', () => {
  const store = new SeenStore({ now: () => 0 });
  assert.equal(store.claim('oc_1:om_1'), true);
  assert.equal(store.claim('oc_2:om_1'), true);
});

test('去重：条目过期后可以重新处理（进程活过重推窗口的边界）', () => {
  let clock = 0;
  const store = new SeenStore({ now: () => clock, ttlMs: 1_000 });
  assert.equal(store.claim('k'), true);
  clock = 999;
  assert.equal(store.claim('k'), false);
  clock = 1_000;
  assert.equal(store.claim('k'), true);
});

test('去重：容量满了淘汰最早的一条，不会无限涨', () => {
  let clock = 0;
  const store = new SeenStore({ now: () => clock, max: 3, ttlMs: 1_000_000 });
  for (let index = 0; index < 5; index += 1) {
    clock += 1;
    store.claim(`k${index}`);
  }
  assert.equal(store.size, 3);
  assert.equal(store.has('k0'), false);
  assert.equal(store.has('k4'), true);
});

test('限速：窗口内放行 max 次，第 max+1 次等到窗口滑过', async () => {
  let clock = 0;
  const waits: number[] = [];
  const gate = new RateGate({
    max: 2,
    windowMs: 1_000,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });

  await gate.acquire();
  await gate.acquire();
  assert.equal(gate.used, 2);

  await gate.acquire();
  assert.deepEqual(waits, [1_000]);
  assert.equal(gate.used, 1, '窗口滑过后只剩新放行的那一条');
});

test('限速：并发调用排队，不会一起抢到同一份配额', async () => {
  let clock = 0;
  const gate = new RateGate({
    max: 3,
    windowMs: 1_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  await Promise.all([gate.acquire(), gate.acquire(), gate.acquire(), gate.acquire()]);
  assert.ok(clock >= 1_000, '第 4 次必须等待窗口');
  assert.ok(gate.used <= 3);
});

test('限速：等待时间按最早一条滑出窗口计算，不会越等越久', async () => {
  let clock = 0;
  const waits: number[] = [];
  const gate = new RateGate({
    max: 1,
    windowMs: 500,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });

  await gate.acquire();
  clock = 300;
  await gate.acquire();
  await gate.acquire();

  assert.deepEqual(waits, [200, 500]);
});
