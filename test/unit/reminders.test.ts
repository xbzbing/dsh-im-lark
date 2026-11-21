import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApprovalBroker } from '../../src/host/approvals.ts';
import { QuestionBroker } from '../../src/host/questions.ts';
import { PendingTable, abortReason, deferred, whenAborted } from '../../src/host/reminder-pending.ts';
import {
  answerFromText,
  classifyAnswer,
  looksLikeAnswer,
  normalizeQuestions,
  parseDecision,
  renderApproval,
  renderQuestions,
} from '../../src/host/reminder-text.ts';
import { Workspaces } from '../../src/host/workspaces.ts';
import { withTempDir } from './helpers/temp.ts';

const OPTIONS = [{ label: '甲' }, { label: '乙' }, { label: '丙', description: '第三个' }];

function questionsOf() {
  return normalizeQuestions([
    { id: 'q1', question: '选一个', options: OPTIONS },
    { id: 'q2', question: '再选一个', options: OPTIONS, multiSelect: true },
  ]);
}

test('提醒文本：题目收窄时丢掉认不出的条目', () => {
  const questions = normalizeQuestions([
    null,
    { id: '', question: '没有 id' },
    { id: 'q1', question: '  选一个  ', header: '标题', options: [null, { label: '' }, { label: '甲', description: '说明' }] },
    { id: 'q2', question: '计划', intent: { kind: 'plan-review', approve: '开工' } },
  ]);

  assert.deepEqual(questions, [
    { id: 'q1', question: '选一个', header: '标题', options: [{ label: '甲', description: '说明' }] },
    { id: 'q2', question: '计划', intent: { kind: 'plan-review', approve: '开工' } },
  ]);
  assert.deepEqual(normalizeQuestions('oops'), []);
});

test('提醒文本：单题认选项文字、序号与自由输入', () => {
  const [single] = normalizeQuestions([{ id: 'q1', question: '选一个', options: OPTIONS }]);

  assert.deepEqual(answerFromText([single!], '乙'), { answers: [{ id: 'q1', selected: ['乙'] }] });
  assert.deepEqual(answerFromText([single!], '3'), { answers: [{ id: 'q1', selected: ['丙'] }] });
  assert.deepEqual(answerFromText([single!], ' 2 '), { answers: [{ id: 'q1', selected: ['乙'] }] });
  // 自由输入落成 custom，不硬塞成选项。
  assert.deepEqual(answerFromText([single!], '都不对，我要别的'), {
    answers: [{ id: 'q1', selected: [], custom: '都不对，我要别的' }],
  });
  // 单题多选才接受逗号分隔的多项。
  assert.deepEqual(answerFromText([single!], '甲,乙'), {
    answers: [{ id: 'q1', selected: [], custom: '甲,乙' }],
  });
});

test('提醒文本：多题按分号/换行分段，段数对上才一题一段', () => {
  const [first, second] = questionsOf();

  assert.deepEqual(answerFromText([first!, second!], '1；甲、乙'), {
    answers: [
      { id: 'q1', selected: ['甲'] },
      { id: 'q2', selected: ['甲', '乙'] },
    ],
  });
  assert.deepEqual(answerFromText([first!, second!], '乙\n2'), {
    answers: [
      { id: 'q1', selected: ['乙'] },
      { id: 'q2', selected: ['乙'] },
    ],
  });
  // 段数对不上：整段当自由输入，不猜。
  assert.deepEqual(answerFromText([first!, second!], '我想想'), {
    answers: [
      { id: 'q1', selected: [], custom: '我想想' },
      { id: 'q2', selected: [], custom: '我想想' },
    ],
  });
});

test('提醒文本：计划审阅认批准词与继续规划，其余算修改意见', () => {
  const [plan] = normalizeQuestions([
    {
      id: 'plan',
      question: '要按这个计划做吗？',
      options: [{ label: '开始' }, { label: '继续规划' }],
      intent: { kind: 'plan-review', approve: '开始' },
    },
  ]);

  assert.deepEqual(answerFromText([plan!], '开始'), { answers: [{ id: 'plan', selected: ['开始'] }] });
  assert.deepEqual(answerFromText([plan!], '批准'), { answers: [{ id: 'plan', selected: ['开始'] }] });
  assert.deepEqual(answerFromText([plan!], '继续规划'), { answers: [{ id: 'plan', selected: ['继续规划'] }] });
  assert.deepEqual(answerFromText([plan!], '先改登录页'), {
    answers: [{ id: 'plan', selected: ['继续规划'], custom: '先改登录页' }],
  });
});

test('提醒文本：单题认任意文本，多题只认都落到选项的作答', () => {
  const [first, second] = questionsOf();

  assert.equal(looksLikeAnswer([first!], '随便聊聊'), true);
  assert.equal(looksLikeAnswer([first!, second!], '1；2'), true);
  assert.equal(looksLikeAnswer([first!, second!], '1；随便聊聊'), false);
  assert.equal(looksLikeAnswer([first!, second!], '只有一个'), false);
  assert.equal(looksLikeAnswer([], '1'), false);
});

test('提醒文本：审批决定只认明确词，编号必须有效', () => {
  assert.deepEqual(parseDecision('批准'), { outcome: 'allowed-once' });
  assert.deepEqual(parseDecision('「批准」。'), { outcome: 'allowed-once' });
  assert.deepEqual(parseDecision('同意 3'), { outcome: 'allowed-once', no: 3 });
  assert.deepEqual(parseDecision('批准#2'), { outcome: 'allowed-once', no: 2 });
  assert.deepEqual(parseDecision('拒绝'), { outcome: 'rejected' });
  assert.deepEqual(parseDecision('deny 1'), { outcome: 'rejected', no: 1 });
  assert.equal(parseDecision('批准 0'), null);
  assert.equal(parseDecision('批准 2.5'), null);
  assert.equal(parseDecision('看看再说'), null);
  assert.equal(parseDecision('   '), null);
});

test('提醒文本：提问与授权的文案含编号与作答方式', () => {
  const [first, second] = questionsOf();
  const questionText = renderQuestions([first!, second!], 2);
  assert.match(questionText, /#2/u);
  assert.match(questionText, /1\. 甲/u);
  assert.match(questionText, /多个用逗号分隔/u);
  assert.match(questionText, /「；」或换行/u);

  const longReason = 'x'.repeat(300);
  const approvalText = renderApproval({ toolName: 'shell', reason: `  ${longReason}\n第二行 ` }, 3);
  assert.match(approvalText, /#3：shell/u);
  assert.match(approvalText, /…/u);
  assert.equal(approvalText.includes('第二行'), false);
  assert.match(approvalText, /批准 3/u);
});

test('待答表：超出上限挤掉最旧的，最新一条可认', () => {
  const table = new PendingTable<{ id: string }>(2);
  table.add({ id: 'a' });
  table.add({ id: 'b' });
  table.add({ id: 'c' });

  assert.deepEqual(table.sweep(), [{ id: 'a' }]);
  assert.equal(table.size, 2);
  assert.deepEqual(table.newest(), { id: 'c' });
  assert.deepEqual(table.newestFirst(), [{ id: 'c' }, { id: 'b' }]);

  table.delete('c');
  assert.equal(table.size, 1);
  table.clear();
  assert.equal(table.size, 0);
});

test('待答表：abort 信号与取消原因带 code', async () => {
  const controller = new AbortController();
  const watcher = whenAborted(controller.signal);
  let fired = false;
  void watcher.promise.then(() => {
    fired = true;
  });
  controller.abort();
  await watcher.promise;
  assert.equal(fired, true);
  watcher.dispose();

  const reason = abortReason('插件已停止');
  assert.equal(reason.name, 'UserQuestionError');
  assert.equal((reason as { code?: string }).code, 'ASK_ABORTED');

  const idle = deferred<string>();
  idle.resolve('ok');
  assert.equal(await idle.promise, 'ok');
});

test('提醒文本：多题半答算 partial，整段聊天不认领', () => {
  const [first, second] = questionsOf();
  const two = [first!, second!];

  assert.equal(classifyAnswer(two, '1；2'), 'complete');
  // 第二段带上解释也仍然能落在选项上：按序号开头就当成在答题。
  assert.equal(classifyAnswer(two, '3\n1还是纯文本'), 'partial');
  // 只有一段、或者两段都不像选项，不能吞成作答。
  assert.equal(classifyAnswer(two, '先不改了'), null);
  assert.equal(classifyAnswer(two, '帮我看看这段代码'), null);
  assert.equal(looksLikeAnswer(two, '3\n1还是纯文本'), false);
});

test('问题提醒：多题只答一半时回格式提示，待答保留', async () => {
  const sent: string[] = [];
  const broker = new QuestionBroker({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
  });

  const pending = broker.handle({ questions: questionsOf() }, async () => {
    throw noProvider();
  }, true);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(broker.snapshot().pending, 1);

  assert.equal(broker.reply('3\n1还是纯文本'), true);
  await tick();
  assert.match(sent.at(-1)!, /作答不完整/u);
  assert.equal(broker.snapshot().pending, 1);

  // 补齐后正常结算。
  assert.equal(broker.reply('1；2'), true);
  assert.deepEqual((await pending as any).answers, [
    { id: 'q1', selected: ['甲'] },
    { id: 'q2', selected: ['乙'] },
  ]);
  assert.equal(broker.snapshot().pending, 0);
});


test('问题提醒：Web 在等待时间内答完就一条都不发', async () => {
  const sent: string[] = [];
  const broker = new QuestionBroker({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 30,
  });

  const value = await broker.handle(
    { questions: [{ id: 'q1', question: '选一个', options: OPTIONS }] },
    async () => 'web-answer',
    true,
  );

  assert.equal(value, 'web-answer');
  assert.deepEqual(sent, []);
  assert.equal(broker.snapshot().pending, 0);
});

test('问题提醒：Web 不在时发提醒，主人作答后取消 Web 那一路', async () => {
  const sent: string[] = [];
  const broker = new QuestionBroker({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
  });

  const request: { questions: unknown; signal?: AbortSignal } = {
    questions: [{ id: 'q1', question: '选一个', options: OPTIONS }],
  };
  const pending = broker.handle(request, async () => {
    const error = new Error('没有监听者');
    (error as { code?: string }).code = 'NO_PROVIDER';
    throw error;
  }, true);

  await tick();
  assert.equal(sent.length, 1);
  assert.equal(broker.snapshot().pending, 1);
  assert.equal(broker.reply('2'), true);

  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['乙'] }] });
  assert.equal(request.signal?.aborted, true);
  assert.match(String((request.signal?.reason as Error).message), /已在飞书作答/u);
  assert.equal(broker.snapshot().pending, 0);
});

test('问题提醒：关闭开关、没有主人、子代理与无题目时原样 next', async () => {
  let sent = 0;
  const make = (overrides: Partial<ConstructorParameters<typeof QuestionBroker>[0]> = {}) =>
    new QuestionBroker({
      send: async () => {
        sent += 1;
        return true;
      },
      recipient: () => 'ou_owner',
      isRoot: () => true,
      delayMs: () => 0,
      ...overrides,
    });

  const next = async () => 'next-value';
  assert.equal(await make({ enabled: () => false }).handle({ questions: OPTIONS }, next, true), 'next-value');
  assert.equal(await make({ recipient: () => null }).handle({ questions: OPTIONS }, next, true), 'next-value');
  assert.equal(await make({ isRoot: () => false }).handle({ questions: OPTIONS }, next, true), 'next-value');
  assert.equal(await make().handle({ questions: [] }, next, true), 'next-value');
  assert.equal(await make().handle({ questions: OPTIONS }, next, false), 'next-value');
  assert.equal(sent, 0);
});

test('问题提醒：发送失败时交回 Web', async () => {
  const broker = new QuestionBroker({
    send: async () => false,
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
    now: () => 123,
  });

  const value = await broker.handle({ questions: [{ id: 'q1', question: '选一个' }] }, async () => 'unavailable', true);
  assert.equal(value, 'unavailable');
  assert.equal(broker.snapshot().lastError?.at, 123);
  assert.match(broker.snapshot().lastError?.message ?? '', /发送失败/u);
});

test('问题提醒：停用时把在等的请求按原因交回', async () => {
  const broker = new QuestionBroker({
    send: async () => true,
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
  });

  const pending = broker.handle(
    { questions: [{ id: 'q1', question: '选一个', options: OPTIONS }] },
    () => new Promise(() => {}),
    true,
  );
  await tick();
  assert.equal(broker.snapshot().pending, 1);

  broker.cancelAll('飞书连接已重建');
  await assert.rejects(pending, /飞书连接已重建/u);
  assert.equal(broker.snapshot().pending, 0);
});

test('问题提醒：超时后交回 Web，不再接受飞书作答', async () => {
  const broker = new QuestionBroker({
    send: async () => true,
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
    waitMs: 10,
  });

  const pending = broker.handle(
    { questions: [{ id: 'q1', question: '选一个', options: OPTIONS }] },
    async () => {
      const error = new Error('没有监听者');
      (error as { code?: string }).code = 'NO_PROVIDER';
      throw error;
    },
    true,
  );

  await tick();
  await assert.rejects(pending, /等待飞书作答超时/u);
  // 超时后这条提醒已摘掉，晚到的回复不再被认领。
  assert.equal(broker.reply('1'), false);
  assert.equal(broker.snapshot().pending, 0);
});

test('授权提醒：Web 回 unavailable 时发提醒，批准只给 allowed-once', async () => {
  const sent: string[] = [];
  const broker = new ApprovalBroker({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    recipient: () => 'ou_owner',
    canApprove: () => true,
    delayMs: () => 0,
  });

  const pending = broker.handle({ toolName: 'shell', reason: '要跑命令', agent: {} }, async () => 'unavailable', true);
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /#1：shell/u);
  assert.equal(broker.snapshot().pending, 1);

  assert.equal(broker.reply('批准'), true);
  assert.equal(await pending, 'allowed-once');
  await tick();
  assert.match(sent[1]!, /已批准：shell（#1）/u);
  assert.equal(broker.snapshot().pending, 0);
});

test('授权提醒：编号指定等待中的某一条，模糊文本不认领', async () => {
  const sent: string[] = [];
  const broker = new ApprovalBroker({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    recipient: () => 'ou_owner',
    canApprove: () => true,
    delayMs: () => 0,
  });

  const first = broker.handle({ toolName: 'read', agent: {} }, async () => 'unavailable', true);
  await tick();
  const second = broker.handle({ toolName: 'write', agent: {} }, async () => 'unavailable', true);
  await tick();
  assert.equal(broker.snapshot().pending, 2);

  assert.equal(broker.reply('再看看'), false);
  assert.equal(broker.reply('拒绝 1'), true);
  assert.equal(await first, 'rejected');
  assert.equal(broker.snapshot().pending, 1);

  assert.equal(broker.reply('批准'), true);
  assert.equal(await second, 'allowed-once');
  assert.equal(broker.snapshot().pending, 0);
  assert.match(sent.at(-1)!, /#2/u);
});

test('授权提醒：拿不到来源、没有主人或停用时一律不接管', async () => {
  let sent = 0;
  const make = (overrides: Partial<ConstructorParameters<typeof ApprovalBroker>[0]> = {}) =>
    new ApprovalBroker({
      send: async () => {
        sent += 1;
        return true;
      },
      recipient: () => 'ou_owner',
      canApprove: () => true,
      delayMs: () => 0,
      ...overrides,
    });
  const next = async () => 'next-value';

  assert.equal(await make({ canApprove: () => false }).handle({ toolName: 'shell' }, next, true), 'next-value');
  assert.equal(await make({ recipient: () => null }).handle({ toolName: 'shell' }, next, true), 'next-value');
  assert.equal(await make({ enabled: () => false }).handle({ toolName: 'shell' }, next, true), 'next-value');
  assert.equal(await make().handle({ toolName: 'shell' }, next, false), 'next-value');
  assert.equal(sent, 0);
});

test('授权提醒：停用与超时都交回 Web，不变成拒绝', async () => {
  const broker = new ApprovalBroker({
    send: async () => true,
    recipient: () => 'ou_owner',
    canApprove: () => true,
    delayMs: () => 0,
  });

  const pending = broker.handle({ toolName: 'shell', agent: {} }, async () => 'unavailable', true);
  await tick();
  broker.cancelAll('已接入核心');
  assert.equal(await pending, 'unavailable');
  assert.equal(broker.snapshot().pending, 0);

  const timed = new ApprovalBroker({
    send: async () => true,
    recipient: () => 'ou_owner',
    canApprove: () => true,
    delayMs: () => 0,
    waitMs: 10,
  });
  assert.equal(await timed.handle({ toolName: 'shell', agent: {} }, async () => 'unavailable', true), 'unavailable');
});

test('工作区：没有宿主服务时不可用，默认 id 为空', async () => {
  await withTempDir(async (dir) => {
    const workspaces = new Workspaces({ dir: `${dir.path}/ws` });
    assert.deepEqual(workspaces.catalog(), { items: [], available: false, reason: '宿主不提供工作区服务', defaultId: '' });
    assert.equal(await workspaces.ensureDefault(), '');
    assert.equal(workspaces.defaultId, '');
  });
});

test('工作区：列表收窄字段，默认工作区建一次并复用 id', async () => {
  await withTempDir(async (dir) => {
    const created: Array<{ path: string; title?: string }> = [];
    const workspaces = new Workspaces({ dir: `${dir.path}/ws` });
    workspaces.attach({
      list: () => [
        { id: 'ws-1', title: ' 项目 ', path: '/tmp/p' },
        { id: '', title: '没有 id' },
        { id: 'ws-2' },
      ],
      create: async (path, title) => {
        created.push({ path, title });
        return { id: 'ws-default' };
      },
    });

    assert.equal(await workspaces.ensureDefault(), 'ws-default');
    assert.equal(workspaces.defaultId, 'ws-default');
    assert.deepEqual(created, [{ path: `${dir.path}/ws`, title: '飞书会话' }]);

    // 再调不会重复创建。
    assert.equal(await workspaces.ensureDefault(), 'ws-default');
    assert.equal(created.length, 1);

    const catalog = workspaces.catalog();
    assert.equal(catalog.available, true);
    assert.equal(catalog.defaultId, 'ws-default');
    assert.deepEqual(catalog.items, [
      { id: 'ws-1', title: '项目', path: '/tmp/p' },
      { id: 'ws-2', title: 'ws-2', path: '' },
    ]);
  });
});

test('工作区：宿主建不出来时退回空串，下次还能重试', async () => {
  await withTempDir(async (dir) => {
    const warnings: unknown[] = [];
    let attempts = 0;
    const workspaces = new Workspaces({
      dir: `${dir.path}/ws`,
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
      timeoutMs: 20,
    });
    workspaces.attach({
      list: () => [],
      create: async () => {
        attempts += 1;
        return {};
      },
    });

    assert.equal(await workspaces.ensureDefault(), '');
    assert.equal(attempts, 1);
    assert.equal(warnings.length, 1);

    // 再试一次：仍失败，但不会卡在旧结果上。
    assert.equal(await workspaces.ensureDefault(), '');
    assert.equal(attempts, 2);
  });
});

test('工作区：宿主一直不返回时按超时放弃', async () => {
  await withTempDir(async (dir) => {
    const workspaces = new Workspaces({ dir: `${dir.path}/ws`, timeoutMs: 10 });
    workspaces.attach({
      list: () => [],
      create: () => new Promise(() => {}),
    });
    assert.equal(await workspaces.ensureDefault(), '');
  });
});

/* ------------------------------------------------------------ 提问卡片（独立模式） */

/** 没配置 Web 端监听器：broker 会继续等飞书作答。 */
function noProvider(): Error {
  const error = new Error('没有监听者');
  (error as { code?: string }).code = 'NO_PROVIDER';
  return error;
}

/** 从渲染出的卡片里取回提醒 id：单选在按钮 value，多选在下拉 value。 */
function reminderOf(card: Record<string, any>): string {
  const element = card.body.elements[1] as Record<string, any>;
  const value = element.tag === 'form'
    ? element.elements[1].behaviors[0].value
    : element.columns[0].elements[0].behaviors[0].value;
  return value.r as string;
}

test('问题提醒：单题选项发卡片而不是文字，卡片回调结算作答并改终态', async () => {
  const cards: Array<Record<string, any>> = [];
  const patches: Array<{ messageId: string; card: Record<string, any> }> = [];
  let texts = 0;
  const broker = new QuestionBroker({
    send: async () => {
      texts += 1;
      return true;
    },
    sendCard: async (card) => {
      cards.push(card as Record<string, any>);
      return 'om_card';
    },
    patchCard: async (messageId, card) => {
      patches.push({ messageId, card: card as Record<string, any> });
    },
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
  });

  const request: { questions: unknown; signal?: AbortSignal } = {
    questions: [{ id: 'q1', question: '选一个', options: OPTIONS }],
  };
  const pending = broker.handle(request, async () => {
    throw noProvider();
  }, true);
  await tick();

  assert.equal(cards.length, 1);
  assert.equal(texts, 0);
  assert.equal(broker.snapshot().pending, 1);

  const reminderId = reminderOf(cards[0]!);
  assert.equal(broker.applyCardAction({ value: { r: reminderId, q: 'q1', o: 1 } }), true);
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['乙'] }] });
  await tick();

  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.messageId, 'om_card');
  assert.match(JSON.stringify(patches[0]!.card), /已在飞书作答：乙/u);
  assert.equal(request.signal?.aborted, true);
  assert.equal(broker.snapshot().pending, 0);
});

test('问题提醒：多选卡的回调带回多项', async () => {
  const cards: Array<Record<string, any>> = [];
  const broker = new QuestionBroker({
    send: async () => true,
    sendCard: async (card) => {
      cards.push(card as Record<string, any>);
      return 'om_multi';
    },
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
  });

  const pending = broker.handle(
    { questions: [{ id: 'q1', question: '多选', options: OPTIONS, multiSelect: true }] },
    async () => {
      throw noProvider();
    },
    true,
  );
  await tick();

  const reminderId = reminderOf(cards[0]!);
  assert.equal(
    broker.applyCardAction({ value: { r: reminderId, q: 'q1' }, formValues: { answer: ['0', '2'] } }),
    true,
  );
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['甲', '丙'] }] });
});

test('问题提醒：卡片发不出去就退回文字', async () => {
  let texts = 0;
  let cards = 0;
  const broker = new QuestionBroker({
    send: async () => {
      texts += 1;
      return true;
    },
    sendCard: async () => {
      cards += 1;
      return null;
    },
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
  });

  broker.handle(
    { questions: [{ id: 'q1', question: '选一个', options: OPTIONS }] },
    async () => {
      throw noProvider();
    },
    true,
  );
  await tick();

  assert.equal(cards, 1);
  assert.equal(texts, 1);
  assert.equal(broker.applyCardAction({ value: { r: 'lark-q-1', q: 'q1', o: 0 } }), true);
});

test('问题提醒：多题仍然只发文字，不上卡片', async () => {
  let cards = 0;
  const sent: string[] = [];
  const broker = new QuestionBroker({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    sendCard: async () => {
      cards += 1;
      return 'om_card';
    },
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
  });

  broker.handle({ questions: questionsOf() }, async () => {
    throw noProvider();
  }, true);
  await tick();

  assert.equal(cards, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /第 1 题/u);
});

test('问题提醒：文字作答也会把卡片改成终态', async () => {
  const patches: Array<Record<string, any>> = [];
  const broker = new QuestionBroker({
    send: async () => true,
    sendCard: async () => 'om_card',
    patchCard: async (_messageId, card) => {
      patches.push(card as Record<string, any>);
    },
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
  });

  const pending = broker.handle(
    { questions: [{ id: 'q1', question: '选一个', options: OPTIONS }] },
    async () => {
      throw noProvider();
    },
    true,
  );
  await tick();

  assert.equal(broker.reply('2'), true);
  assert.deepEqual(await pending, { answers: [{ id: 'q1', selected: ['乙'] }] });
  await tick();
  assert.match(JSON.stringify(patches.at(-1)), /已在飞书作答：乙/u);
});

test('问题提醒：Web 先答时卡片改成「已在 Web 端作答」', async () => {
  const patches: Array<Record<string, any>> = [];
  const broker = new QuestionBroker({
    send: async () => true,
    sendCard: async () => 'om_card',
    patchCard: async (_messageId, card) => {
      patches.push(card as Record<string, any>);
    },
    recipient: () => 'ou_owner',
    isRoot: () => true,
    delayMs: () => 0,
  });

  assert.equal(
    await broker.handle({ questions: [{ id: 'q1', question: '选一个', options: OPTIONS }] }, async () => 'web-answer', true),
    'web-answer',
  );
  await tick();
  assert.match(JSON.stringify(patches.at(-1)), /Web 端作答/u);
  assert.equal(broker.snapshot().pending, 0);
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
