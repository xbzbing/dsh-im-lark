import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_LONG_TASK_MINUTES,
  LongTaskNotifier,
  durationText,
  longTaskText,
  normalizeLongTaskMinutes,
} from '../../src/host/long-tasks.ts';

const MINUTE = 60_000;
const START = 1_760_000_000_000;

interface Harness {
  notifier: LongTaskNotifier;
  sent: string[];
  setActive(value: boolean): void;
}

function harness(overrides: {
  enabled?: boolean;
  failureReminders?: boolean;
  thresholdMinutes?: number;
  suppressCompletion?: (sessionId: string) => boolean;
  recipient?: string | null;
} = {}): Harness {
  const sent: string[] = [];
  let active = true;
  const notifier = new LongTaskNotifier({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    recipient: () => (overrides.recipient === undefined ? 'ou_owner' : overrides.recipient),
    isActive: () => active,
    titleOf: (sessionId) => (sessionId === 's1' ? '修长连接' : null),
    enabled: overrides.enabled ?? true,
    failureReminders: overrides.failureReminders ?? true,
    thresholdMinutes: overrides.thresholdMinutes ?? 30,
    ...(overrides.suppressCompletion === undefined ? {} : { suppressCompletion: overrides.suppressCompletion }),
  });
  return {
    notifier,
    sent,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

function turnStart(sessionId: string, at: number, turn = 1): void {
  void sessionId;
  void at;
  void turn;
}

/** 把「开始 → 回答 → 结束」压成一个事件序列喂进去。 */
function runTurn(
  harnessed: Harness,
  options: {
    sessionId?: string;
    minutes: number;
    reason?: unknown;
    answer?: string;
    session?: unknown;
    turn?: number;
  },
): void {
  const sessionId = options.sessionId ?? 's1';
  const session = options.session ?? { id: sessionId, header: {} };
  const turn = options.turn ?? 1;
  harnessed.notifier.handleEvent(session, { type: 'turn/start', time: START, data: { turn } });
  if (options.answer !== undefined) {
    harnessed.notifier.handleEvent(session, {
      type: 'assistant/message',
      time: START + 1_000,
      data: { turn, message: { content: [{ type: 'text', text: options.answer }] } },
    });
  }
  harnessed.notifier.handleEvent(session, {
    type: 'turn/end',
    time: START + options.minutes * MINUTE,
    data: { turn, reason: options.reason ?? { kind: 'completed' } },
  });
}

test('长任务：超过阈值且正常结束才发提醒，带标题、耗时与结论', () => {
  const h = harness();
  runTurn(h, { minutes: 31, answer: '构建通过，已提交' });

  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /长程任务完成 · 修长连接/u);
  assert.match(h.sent[0]!, /耗时：31分0秒/u);
  assert.match(h.sent[0]!, /结果：已完成/u);
  assert.match(h.sent[0]!, /构建通过，已提交/u);
});

test('长任务：没有超过阈值时不打扰', () => {
  const h = harness();
  runTurn(h, { minutes: 29, answer: '很快' });
  assert.deepEqual(h.sent, []);
});

test('长任务：关掉完成提醒后，长回合也静默', () => {
  const h = harness({ enabled: false });
  runTurn(h, { minutes: 90, answer: '跑完了' });
  assert.deepEqual(h.sent, []);
});

test('失败：不看耗时，立刻提醒并带上平台原文', () => {
  const h = harness();
  runTurn(h, {
    minutes: 1,
    reason: { kind: 'error', error: { message: '当前请求的额度已用尽' } },
  });

  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /任务失败 · 修长连接/u);
  assert.match(h.sent[0]!, /结果：执行失败/u);
  assert.match(h.sent[0]!, /原因：当前请求的额度已用尽/u);
});

test('失败：被外部中止按失败算', () => {
  const h = harness();
  runTurn(h, { minutes: 2, reason: { kind: 'aborted' } });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /任务失败/u);
});

test('失败：主人自己按停止不提醒', () => {
  const h = harness();
  runTurn(h, { minutes: 40, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  assert.deepEqual(h.sent, []);
});

test('失败：关掉失败提醒后，失败也不提醒（不降级成完成提醒）', () => {
  const h = harness({ failureReminders: false });
  runTurn(h, { minutes: 50, reason: { kind: 'error', error: { message: 'boom' } } });
  assert.deepEqual(h.sent, []);
});

test('子代理会话不提醒', () => {
  const h = harness();
  runTurn(h, { minutes: 60, session: { id: 's1', header: { origin: 'subagent' } }, answer: '子任务' });
  assert.deepEqual(h.sent, []);
});

test('拿不到会话来源时放行（宁可多提醒）', () => {
  const h = harness();
  h.notifier.handleEvent('s1', { type: 'turn/start', time: START, data: { turn: 1 } });
  h.notifier.handleEvent('s1', { type: 'turn/end', time: START + 40 * MINUTE, data: { reason: { kind: 'completed' } } });
  assert.equal(h.sent.length, 1);
});

test('非独立模式生效时不发任何提醒', () => {
  const h = harness();
  h.setActive(false);
  runTurn(h, { minutes: 90, answer: '跑完了' });
  assert.deepEqual(h.sent, []);
});

test('没有主人时丢弃提醒，不抛错', () => {
  const h = harness({ recipient: null });
  runTurn(h, { minutes: 90, answer: '跑完了' });
  assert.deepEqual(h.sent, []);
});

test('绑定的会话跳过完成提醒，但失败仍然提醒', () => {
  const h = harness({ suppressCompletion: (sessionId) => sessionId === 's1' });
  runTurn(h, { minutes: 90, answer: '这条路已经发过回答了' });
  assert.deepEqual(h.sent, []);

  runTurn(h, { minutes: 5, reason: { kind: 'error', error: { message: '炸了' } } });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /任务失败/u);
});

test('同一回合重复的 turn/start 不重置起点', () => {
  const h = harness();
  h.notifier.handleEvent('s1', { type: 'turn/start', time: START, data: { turn: 1 } });
  h.notifier.handleEvent('s1', { type: 'turn/start', time: START + 70 * MINUTE, data: { turn: 1 } });
  h.notifier.handleEvent('s1', { type: 'turn/end', time: START + 71 * MINUTE, data: { reason: { kind: 'completed' } } });
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /耗时：71分0秒/u);
});

test('新回合不继承上一轮的回答', () => {
  const h = harness({ thresholdMinutes: 1 });
  runTurn(h, { minutes: 2, answer: '上一轮的结论' });
  h.notifier.handleEvent('s1', { type: 'turn/start', time: START + 3 * MINUTE, data: { turn: 2 } });
  h.notifier.handleEvent('s1', { type: 'turn/end', time: START + 5 * MINUTE, data: { reason: { kind: 'error', error: { message: '挂了' } } } });

  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /没有可提取的文本结论/u);
  assert.doesNotMatch(h.sent[1]!, /上一轮的结论/u);
});

test('阈值：收窄到 1–1440 分钟，非法值交给调用方回落默认', () => {
  assert.equal(normalizeLongTaskMinutes(45), 45);
  assert.equal(normalizeLongTaskMinutes(1), 1);
  assert.equal(normalizeLongTaskMinutes(1440), 1440);
  assert.equal(normalizeLongTaskMinutes(0), undefined);
  assert.equal(normalizeLongTaskMinutes(1441), undefined);
  assert.equal(normalizeLongTaskMinutes('45'), undefined);
  assert.equal(DEFAULT_LONG_TASK_MINUTES, 30);
});

test('耗时文案：不足一分钟只说秒', () => {
  assert.equal(durationText(45_000), '45秒');
  assert.equal(durationText(61_000), '1分1秒');
  assert.equal(durationText(0), '0秒');
});

test('正文超长时截断，保留结尾省略号', () => {
  const text = longTaskText({ title: 'T', durationMs: MINUTE, failed: false, answer: 'x'.repeat(500), maxChars: 120 });
  assert.equal(text.length, 120);
  assert.match(text, /…$/u);
});

test('清理会话后不再跟踪', () => {
  const h = harness();
  h.notifier.handleEvent('s1', { type: 'turn/start', time: START, data: { turn: 1 } });
  assert.equal(h.notifier.tracking, 1);
  h.notifier.clearSession('s1');
  assert.equal(h.notifier.tracking, 0);
  h.notifier.handleEvent('s1', { type: 'turn/end', time: START + 99 * MINUTE, data: { reason: { kind: 'completed' } } });
  assert.deepEqual(h.sent, []);
});

// 保留给将来扩展：这里只是确保辅助函数没被误删。
void turnStart;
