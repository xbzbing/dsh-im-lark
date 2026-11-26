import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InteractionStore,
  answerFromAction,
  cardBytes,
  cardComponents,
  cardFits,
  renderAnsweredCard,
  renderDeliveryCard,
  renderMarkdownCard,
  renderRetryCard,
  renderSupersededCard,
} from '../../src/host/cards.ts';
import type { Delivery, InteractionQuestion } from '../../src/host/protocol.ts';

const DELIVERY: Delivery = {
  protocol: 'my-superagent/v1',
  id: 'dlv_1',
  recipient: 'oc_1',
  intent: 'result',
  title: '回答',
  body: '正文',
};

interface CardShape {
  header?: { title: { content: string } };
  body: { elements: Array<Record<string, unknown>> };
}

/** 卡片里的选择行：单选/多选都用 checker，可能直接挂在 body 或包在表单里。 */
function checkersOf(card: unknown): Array<{
  text: { content: string };
  behaviors?: Array<{ value: Record<string, unknown> }>;
}> {
  const elements = (card as CardShape).body.elements;
  const direct = elements.filter((element) => element.tag === 'checker');
  const nested = elements
    .filter((element) => element.tag === 'form')
    .flatMap((element) => (element.elements as Array<Record<string, unknown>>).filter((child) => child.tag === 'checker'));
  return [...direct, ...nested] as never;
}

test('卡片：Markdown 卡带标题与 update_multi（PATCH 的前提）', () => {
  const card = renderMarkdownCard('**粗体**', { title: '标题' }) as unknown as CardShape & {
    config: { update_multi: boolean };
    schema: string;
  };

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(card.header?.title.content, '标题');
  assert.equal(card.body.elements[0]!.content, '**粗体**');
});

test('交付卡：标题、正文、详情、参考按顺序出现', () => {
  const card = renderDeliveryCard({
    ...DELIVERY,
    detail: '细节',
    refs: [{ kind: 'session', id: 's_1', title: '会话一' }],
  }) as unknown as CardShape;
  const markdown = card.body.elements[0]!.content as string;

  assert.equal(card.header?.title.content, '回答');
  assert.match(markdown, /正文/);
  assert.match(markdown, /---\n\n细节/);
  assert.match(markdown, /参考：\n- 会话一/);
});

test('交付卡：单选也是勾选器，文案说明只能勾一项、点提交生效', () => {
  const card = renderDeliveryCard(
    {
      ...DELIVERY,
      interaction: { questions: [{ id: 'q1', header: '画幅', question: '选一个', options: [{ label: '甲', description: '第一个' }, { label: '乙' }] }] },
    },
    { interactive: true },
  );

  const shape = card as unknown as CardShape;
  assert.match(JSON.stringify(shape.body.elements), /单选：只能勾选一项/u);
  const form = shape.body.elements.find((element) => element.tag === 'form') as
    | { elements: Array<Record<string, any>> }
    | undefined;
  assert.ok(form !== undefined);

  const rows = checkersOf(card);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.text.content, /第一个/u);
  // 点勾选框不直接作答：值只在提交按钮上。
  assert.equal(rows[0]!.behaviors, undefined);
  const submit = form.elements.at(-1)!;
  assert.deepEqual(submit.behaviors[0]!.value, { d: 'dlv_1' });
  // 题干里的标题与问题都要出现，不能只剩「请选择」。
  assert.match(JSON.stringify(shape.body.elements), /画幅：选一个/u);
});

test('交付卡：多选用勾选器，值用序号避免文案里的逗号歧义', () => {
  const card = renderDeliveryCard(
    {
      ...DELIVERY,
      interaction: {
        questions: [{ id: 'q2', question: '多选', multiSelect: true, options: [{ label: '甲,乙' }, { label: '丙' }] }],
      },
    },
    { interactive: true },
  ) as unknown as CardShape;

  const form = card.body.elements.find((element) => element.tag === 'form') as
    | { name: string; elements: Array<Record<string, any>> }
    | undefined;
  assert.ok(form !== undefined);
  assert.equal(form.name, 'ask_form');

  // 每个选项一个勾选框，勾选值随表单提交（answer_<题号>_<选项号>），没有下拉多选。
  const checkers = form.elements.filter((element) => element.tag === 'checker') as Array<
    { name: string; text: { content: string } }
  >;
  assert.deepEqual(checkers.map((checker) => checker.name), ['answer_0_0', 'answer_0_1']);
  assert.match(checkers[0]!.text.content, /甲,乙/u);

  // 没有提交按钮时勾完无处可点：按钮必须带 form_action_type=submit 并携带交付 id。
  const submit = form.elements.find((element) => element.tag === 'button') as
    | { form_action_type: string; behaviors: Array<{ value: Record<string, unknown> }> }
    | undefined;
  assert.ok(submit !== undefined);
  assert.equal(submit.form_action_type, 'submit');
  assert.deepEqual(submit.behaviors[0]!.value, { d: 'dlv_1' });
});

test('交付卡：审批类不给按钮，只提示去 Web 端', () => {
  const card = renderDeliveryCard(
    {
      ...DELIVERY,
      interaction: {
        questions: [{ id: 'q3', question: '是否合并', intent: 'approval', options: [{ label: '同意' }] }],
      },
    },
    { interactive: true },
  ) as unknown as CardShape;

  assert.equal(checkersOf(card).length, 0);
  assert.match(JSON.stringify(card), /Web 端处理/);
});

test('交付卡：多题收进同一张 form，一次提交答完', () => {
  const card = renderDeliveryCard(
    {
      ...DELIVERY,
      interaction: {
        questions: [
          { id: 'q1', header: '主角', question: '第一题', options: [{ label: '甲' }, { label: '乙' }] },
          { id: 'q2', header: '画幅', question: '第二题', options: [{ label: '丙' }] },
          { id: 'q3', question: '第三题（自由填写）' },
        ],
      },
    },
    { interactive: true },
  ) as unknown as CardShape;

  // 只有一张表单：多张表单会变成「先答一题再答一题」，核心不接受分批作答。
  const forms = card.body.elements.filter((element) => element.tag === 'form');
  assert.equal(forms.length, 1);
  const form = forms[0] as { elements: Array<Record<string, any>> };

  // 控件 name 全卡唯一：带上题号，否则多题同名的勾选框会互相覆盖。
  const names = form.elements.filter((element) => typeof element.name === 'string').map((element) => element.name as string);
  assert.deepEqual(names, ['answer_0_0', 'answer_0_1', 'custom_0', 'answer_1_0', 'custom_1', 'custom_2', 'ask_submit']);
  assert.equal(new Set(names).size, names.length);

  // 题干、题号都在卡上：①②③ 区分题目，选项是纯数字序号。
  const markdown = JSON.stringify(card.body.elements);
  assert.match(markdown, /\*\*① 主角：第一题\*\*/u);
  assert.match(markdown, /② 画幅：第二题/u);
  assert.match(markdown, /③ 第三题/u);

  // 一个提交按钮，带交付 id 与「几题」的文案。
  const submit = form.elements.at(-1)!;
  assert.deepEqual(submit.behaviors[0]!.value, { d: 'dlv_1' });
  assert.match(submit.text.content, /提交 3 题答案/u);
});

test('交付卡：重画时回填已勾选与已填内容', () => {
  const card = renderRetryCard(
    {
      ...DELIVERY,
      interaction: {
        questions: [
          { id: 'q1', question: '甲？', options: [{ label: '一' }, { label: '二' }] },
          { id: 'q2', question: '补充' },
        ],
      },
    },
    '第 2 题还没有作答',
    { answer_0_1: true, custom_1: '已填内容' },
  ) as unknown as CardShape;

  const form = card.body.elements.find((element) => element.tag === 'form') as {
    elements: Array<Record<string, any>>;
  };
  assert.equal(form.elements.find((element) => element.name === 'answer_0_1')!.checked, true);
  assert.equal(form.elements.find((element) => element.name === 'answer_0_0')!.checked, false);
  assert.equal(form.elements.find((element) => element.name === 'custom_1')!.default_value, '已填内容');
});

test('交付卡：多题超出协议上限时不给控件，完整列出题目与回复指引', () => {
  const tooMany = renderDeliveryCard(
    {
      ...DELIVERY,
      interaction: {
        questions: Array.from({ length: 11 }, (_, index) => ({ id: `q${index}`, question: `第 ${index + 1} 题`, options: [{ label: '甲' }] })),
      },
    },
    { interactive: true },
  );
  assert.equal(checkersOf(tooMany).length, 0);
  // 兜底也要把选项和「怎么回」写清楚，否则用户只看到光秃秃的题干。
  const text = JSON.stringify(tooMany);
  assert.match(text, /第 11 题/u);
  assert.match(text, /1\. 甲/u);
  assert.match(text, /按题目顺序分行/u);
});

test('已作答卡：不再有按钮，附上选择结果', () => {
  const delivery: Delivery = {
    ...DELIVERY,
    interaction: { questions: [{ id: 'q1', header: '问题', question: '选一个', options: [{ label: '甲' }] }] },
  };
  const card = renderAnsweredCard(delivery, [{ id: 'q1', selected: ['甲'] }]);

  assert.equal(checkersOf(card).length, 0);
  assert.match(JSON.stringify(card), /已作答/);
  assert.match(JSON.stringify(card), /问题：甲/);
});

test('已作答卡：勾选与「其他」同时展示', () => {
  const delivery: Delivery = {
    ...DELIVERY,
    interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }] }] },
  };
  const card = renderAnsweredCard(delivery, [{ id: 'q1', selected: ['甲'], custom: '补充说明' }]);
  assert.match(JSON.stringify(card), /甲；补充说明/u);
});

test('被替代卡：明确说明不再有效', () => {
  assert.match(JSON.stringify(renderSupersededCard(DELIVERY)), /已被新卡片替代/);
});

test('卡片组件数：200 通过，201 拒绝', () => {
  const card = (count: number) => ({
    schema: '2.0',
    body: { elements: Array.from({ length: count }, () => ({ tag: 'markdown', content: 'x' })) },
  });
  assert.equal(cardComponents(card(200)), 200);
  assert.equal(cardFits(card(200)), true);
  assert.equal(cardComponents(card(201)), 201);
  assert.equal(cardFits(card(201)), false);
});

test('卡片体积：超过上限时 cardFits 为 false', () => {
  const big = renderMarkdownCard('汉'.repeat(20_000));
  assert.equal(cardBytes(big) > 28 * 1024, true);
  assert.equal(cardFits(big), false);
  assert.equal(cardFits(renderMarkdownCard('短')), true);
});

/** 造一份待作答记录。 */
function storeWith(questions: readonly InteractionQuestion[], overrides: Partial<{ answered: boolean; expiresAt: number }> = {}): InteractionStore {
  const store = new InteractionStore();
  store.add({
    deliveryId: 'dlv_1',
    chatId: 'oc_1',
    messageId: 'om_1',
    questions,
    createdAt: 0,
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    answered: overrides.answered ?? false,
  });
  return store;
}

const CHOICE: InteractionQuestion = { id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] };

test('作答：单选勾一项 → 选项文案', () => {
  const store = storeWith([CHOICE]);
  const result = answerFromAction({ d: 'dlv_1' }, { answer_0_1: true }, 'ou_owner', store, 10);
  assert.ok(!('reason' in result));
  assert.deepEqual(result.answers, [{ id: 'q1', selected: ['乙'] }]);
  assert.equal(result.sender, 'ou_owner');
});

test('作答：多选勾多项按选项顺序还原', () => {
  const multi: InteractionQuestion = { ...CHOICE, id: 'q2', multiSelect: true };
  const result = answerFromAction({ d: 'dlv_1' }, { answer_0_1: true, answer_0_0: true }, 'ou', storeWith([multi]), 0);
  assert.ok(!('reason' in result));
  assert.deepEqual(result.answers[0]!.selected, ['甲', '乙']);
});

test('作答：「其他」输入落成 custom（多选可与勾选并存）', () => {
  const single = answerFromAction({ d: 'dlv_1' }, { custom_0: '都不合适' }, 'ou', storeWith([CHOICE]), 0);
  assert.ok(!('reason' in single));
  assert.deepEqual(single.answers, [{ id: 'q1', selected: [], custom: '都不合适' }]);

  const multi: InteractionQuestion = { ...CHOICE, id: 'q2', multiSelect: true };
  const both = answerFromAction(
    { d: 'dlv_1' },
    { answer_0_0: true, custom_0: '补充一句' },
    'ou',
    storeWith([multi]),
    0,
  );
  assert.ok(!('reason' in both));
  assert.deepEqual(both.answers, [{ id: 'q2', selected: ['甲'], custom: '补充一句' }]);
});

test('作答：单选勾选并填「其他」时以「其他」为准', () => {
  const result = answerFromAction(
    { d: 'dlv_1' },
    { answer_0_0: true, custom_0: '都不合适' },
    'ou',
    storeWith([CHOICE]),
    0,
  );
  assert.ok(!('reason' in result));
  assert.deepEqual(result.answers, [{ id: 'q1', selected: [], custom: '都不合适' }]);
});

test('作答：多题一次提交产出全部答项', () => {
  const store = storeWith([
    { id: 'q1', question: '主角', options: [{ label: '少年' }, { label: '少女' }] },
    { id: 'q2', question: '画幅', options: [{ label: '竖屏' }] },
    { id: 'q3', question: '补充说明' },
  ]);
  const result = answerFromAction(
    { d: 'dlv_1' },
    { answer_0_1: true, answer_1_0: true, custom_2: '尽量写实' },
    'ou',
    store,
    0,
  );
  assert.ok(!('reason' in result));
  assert.deepEqual(result.answers, [
    { id: 'q1', selected: ['少女'] },
    { id: 'q2', selected: ['竖屏'] },
    { id: 'q3', selected: [], custom: '尽量写实' },
  ]);
});

test('作答：少答一题时拒收并指出是第几题', () => {
  const store = storeWith([
    { id: 'q1', question: '甲？', options: [{ label: '一' }] },
    { id: 'q2', question: '乙？', options: [{ label: '二' }] },
  ]);
  const result = answerFromAction({ d: 'dlv_1' }, { answer_0_0: true }, 'ou', store, 0);
  assert.ok('reason' in result);
  assert.equal(result.reason, 'invalid-answer');
  // 核心要求一次答完全部题目：少答就整单退回，提示要说清缺哪一题。
  assert.match(result.detail ?? '', /第 2 题/u);
});

test('作答：单选题勾了多项时拒收并指出是第几题', () => {
  const multi: InteractionQuestion = { ...CHOICE, id: 'q2', multiSelect: true };
  const store = storeWith([CHOICE, multi]);
  const result = answerFromAction(
    { d: 'dlv_1' },
    { answer_0_0: true, answer_0_1: true, answer_1_0: true },
    'ou',
    store,
    0,
  );
  assert.ok('reason' in result);
  assert.equal(result.reason, 'invalid-answer');
  assert.match(result.detail ?? '', /第 1 题是单选题/u);
});

test('作答：已作答、过期、未知交付、缺表单值分别给出协议原因', () => {
  assert.equal(reasonOf(storeWith([CHOICE], { answered: true }), { d: 'dlv_1' }, { answer_0_0: true }), 'settled');
  assert.equal(reasonOf(storeWith([CHOICE], { expiresAt: 5 }), { d: 'dlv_1' }, { answer_0_0: true }, 10), 'expired');
  assert.equal(reasonOf(new InteractionStore(), { d: 'dlv_x' }, { answer_0_0: true }), 'unknown');
  assert.equal(reasonOf(storeWith([CHOICE]), { d: 'dlv_1' }, undefined), 'invalid-answer');
});

test('作答：未知交付与缺交付 id 的提示是给用户看的', () => {
  const unknown = answerFromAction({ d: 'dlv_x' }, {}, 'ou', new InteractionStore(), 0);
  assert.ok('reason' in unknown);
  assert.match(unknown.detail ?? '', /失效/u);
  assert.match(unknown.detail ?? '', /Web 端/u);

  const invalid = answerFromAction({}, {}, 'ou', new InteractionStore(), 0);
  assert.ok('reason' in invalid);
  assert.match(invalid.detail ?? '', /重新作答/u);
});

test('作答：缺交付 id、或勾了不存在的选项都算无效', () => {
  const store = storeWith([CHOICE]);
  assert.equal(reasonOf(store, {}, { answer_0_0: true }), 'invalid');
  // 名字里没有这道题的选项（比如旧卡片留下的 answer_9）不会凭空变成答项。
  assert.equal(reasonOf(store, { d: 'dlv_1' }, { answer_0_9: true }), 'invalid-answer');
});

function reasonOf(store: InteractionStore, value: Record<string, unknown>, formValues?: Record<string, unknown>, now = 0): string {
  const result = answerFromAction(value, formValues, 'ou', store, now);
  return 'reason' in result ? result.reason : 'accepted';
}
