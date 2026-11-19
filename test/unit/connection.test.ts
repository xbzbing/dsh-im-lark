import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EVENT_CARD_ACTION, EVENT_MESSAGE_RECEIVE, LarkConnection } from '../../src/host/lark/connection.ts';
import type {
  EventDispatcherLike,
  LarkConnectionStatus,
  WsClientLike,
} from '../../src/host/lark/connection.ts';
import { fakeClock } from './helpers/temp.ts';

interface FakeWs {
  client: WsClientLike;
  /** 触发 SDK 的状态回调。 */
  fire(name: 'onReady' | 'onReconnecting' | 'onReconnected' | 'onError', payload?: unknown): void;
  startCalls: number;
  closeCalls: number;
  /** SDK 的实时状态（`getConnectionStatus`）。 */
  live: { state?: string; reconnectAttempts?: number };
  handlers: Record<string, (data: unknown) => unknown>;
}

/** 假 WSClient：行为由测试驱动，不碰网络。 */
function fakeWsFactory(): { create(params: Record<string, unknown>): WsClientLike; last(): FakeWs } {
  let last: FakeWs | undefined;

  const create = (params: Record<string, unknown>): WsClientLike => {
    const state: FakeWs = {
      startCalls: 0,
      closeCalls: 0,
      live: { state: 'connecting', reconnectAttempts: 0 },
      handlers: {},
      client: {
        start({ eventDispatcher }) {
          state.startCalls += 1;
          // EventDispatcherLike 只用于承接事件；这里记下 handler 便于触发。
          void eventDispatcher;
          return Promise.resolve();
        },
        close() {
          state.closeCalls += 1;
        },
        getConnectionStatus() {
          return state.live;
        },
      },
      fire(name, payload) {
        if (name === 'onReady' || name === 'onReconnected') state.live = { state: 'connected', reconnectAttempts: 0 };
        if (name === 'onReconnecting') state.live = { state: 'reconnecting', reconnectAttempts: 1 };
        if (name === 'onError') state.live = { state: 'failed', reconnectAttempts: 3 };
        const callback = params[name];
        if (typeof callback === 'function') (callback as (value: unknown) => void)(payload);
      },
    };
    last = state;
    return state.client;
  };

  return {
    create,
    last() {
      if (!last) throw new Error('还没有创建过客户端');
      return last;
    },
  };
}

function fakeDispatcherFactory(sink: { handlers: Record<string, (data: unknown) => unknown> }) {
  const dispatcher: EventDispatcherLike = {
    register(handles) {
      Object.assign(sink.handlers, handles);
      return dispatcher;
    },
  };
  return () => dispatcher;
}

const APP = { appId: 'cli_test_app', appSecret: 'test-secret', domain: 'feishu' as const };

/** 建一个会自动进入 connected 的连接（onReady 在 start 期间触发）。 */
async function connectedConnection(): Promise<{
  connection: LarkConnection;
  ws: FakeWs;
  handlers: Record<string, (data: unknown) => unknown>;
  statuses: LarkConnectionStatus[];
  clock: ReturnType<typeof fakeClock>;
}> {
  const clock = fakeClock();
  const wsFactory = fakeWsFactory();
  const sink = { handlers: {} as Record<string, (data: unknown) => unknown> };
  const statuses: LarkConnectionStatus[] = [];

  // 包一层：在 onReady 里立刻把状态推进到 connected，模拟 SDK 握手成功。
  const createWsClient = (params: Record<string, unknown>): WsClientLike => {
    const wrapped = {
      ...params,
      onReady: () => {
        (params.onReady as (() => void) | undefined)?.();
      },
    };
    return wsFactory.create(wrapped);
  };

  const connection = new LarkConnection({
    app: APP,
    now: clock.now,
    createWsClient,
    createDispatcher: fakeDispatcherFactory(sink),
    onStatus: (status) => statuses.push(status),
  });

  const startPromise = connection.start({ onMessage: () => {}, onCardAction: () => {} });
  // 握手等待是轮询式的：让出若干轮事件循环后触发 onReady。
  await Promise.resolve();
  wsFactory.last().fire('onReady');
  await startPromise;

  return { connection, ws: wsFactory.last(), handlers: sink.handlers, statuses, clock };
}

test('连接：握手成功后状态是 connected，并注册了两个事件', async () => {
  const { connection, handlers, statuses } = await connectedConnection();
  assert.equal(connection.status().state, 'connected');
  assert.ok(handlers[EVENT_MESSAGE_RECEIVE], '应注册接收消息事件');
  assert.ok(handlers[EVENT_CARD_ACTION], '应注册卡片回调');
  assert.equal(statuses.at(-1)?.state, 'connected');
});

test('连接：事件回调把原始事件交给调用方', async () => {
  const clock = fakeClock();
  const wsFactory = fakeWsFactory();
  const sink = { handlers: {} as Record<string, (data: unknown) => unknown> };
  const received: unknown[] = [];
  const actions: unknown[] = [];

  const createWsClient = (params: Record<string, unknown>): WsClientLike => {
    const wrapped = {
      ...params,
      onReady: () => {
        (params.onReady as (() => void) | undefined)?.();
      },
    };
    return wsFactory.create(wrapped);
  };

  const connection = new LarkConnection({
    app: APP,
    now: clock.now,
    createWsClient,
    createDispatcher: fakeDispatcherFactory(sink),
  });

  const starting = connection.start({
    onMessage: (envelope) => received.push(envelope),
    onCardAction: (envelope) => actions.push(envelope),
  });
  await Promise.resolve();
  wsFactory.last().fire('onReady');
  await starting;

  sink.handlers[EVENT_MESSAGE_RECEIVE]({ event: { message: { message_id: 'om_1' } } });
  sink.handlers[EVENT_CARD_ACTION]({ event: { action: { value: { a: 1 } } } });

  assert.equal(received.length, 1);
  assert.equal(actions.length, 1);
});

test('连接：收到帧会刷新 lastFrameAt，超过窗口判定为假活', async () => {
  const { connection, handlers, clock } = await connectedConnection();
  const before = connection.status().lastFrameAt;
  assert.ok(before !== undefined);

  clock.advance(5_000);
  handlers[EVENT_MESSAGE_RECEIVE]({ event: { message: { message_id: 'om_2' } } });
  assert.equal(connection.status().lastFrameAt, before + 5_000);

  // 窗口默认是看门狗（45 秒）的两倍：90 秒内不算假活。
  clock.advance(60_000);
  assert.equal(connection.looksStalled(), false);
  clock.advance(40_000);
  assert.equal(connection.looksStalled(), true);
});

test('连接：断线进入 reconnecting，重连成功回到 connected', async () => {
  const { connection, ws } = await connectedConnection();
  ws.fire('onReconnecting');
  assert.equal(connection.status().state, 'reconnecting');
  assert.equal(connection.status().reconnectAttempts, 1);

  ws.fire('onReconnected');
  assert.equal(connection.status().state, 'connected');
  assert.equal(connection.status().reconnectAttempts, 0);
});

test('连接：SDK 报放弃时直接落 failed，并保留原因', async () => {
  const { connection, ws } = await connectedConnection();
  ws.fire('onError', new Error('boom-terminal'));
  assert.equal(connection.status().state, 'failed');
  assert.match(connection.status().lastError ?? '', /boom-terminal/);
});

test('连接：stop 之后到达的事件一律忽略', async () => {
  const clock = fakeClock();
  const wsFactory = fakeWsFactory();
  const sink = { handlers: {} as Record<string, (data: unknown) => unknown> };
  const received: unknown[] = [];

  const createWsClient = (params: Record<string, unknown>): WsClientLike => {
    const wrapped = {
      ...params,
      onReady: () => (params.onReady as (() => void) | undefined)?.(),
    };
    return wsFactory.create(wrapped);
  };

  const connection = new LarkConnection({
    app: APP,
    now: clock.now,
    createWsClient,
    createDispatcher: fakeDispatcherFactory(sink),
  });

  const starting = connection.start({
    onMessage: (envelope) => received.push(envelope),
    onCardAction: () => {},
  });
  await Promise.resolve();
  wsFactory.last().fire('onReady');
  await starting;

  connection.stop();
  assert.equal(connection.status().state, 'idle');
  assert.equal(wsFactory.last().closeCalls, 1);

  sink.handlers[EVENT_MESSAGE_RECEIVE]({ event: { message: { message_id: 'om_late' } } });
  assert.equal(received.length, 0, '停掉之后的帧不该再进流水线');
});

test('连接：SDK 实时状态优先于回调快照', async () => {
  const { connection, ws } = await connectedConnection();
  ws.live = { state: 'reconnecting', reconnectAttempts: 4 };
  const status = connection.status();
  assert.equal(status.state, 'reconnecting');
  assert.equal(status.reconnectAttempts, 4);
});

test('连接：握手超时按 failed 报出，不无限等', async () => {
  const clock = fakeClock();
  const sink = { handlers: {} as Record<string, (data: unknown) => unknown> };
  // 这个客户端永远不 fire onReady。
  const connection = new LarkConnection({
    app: APP,
    now: clock.now,
    handshakeTimeoutMs: 30,
    createWsClient: () => ({
      start: () => Promise.resolve(),
      close: () => {},
      getConnectionStatus: () => ({ state: 'connecting' }),
    }),
    createDispatcher: fakeDispatcherFactory(sink),
  });

  await assert.rejects(
    connection.start({ onMessage: () => {}, onCardAction: () => {} }),
    /握手超时/,
  );
  assert.equal(connection.status().state, 'failed');
});
