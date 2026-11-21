import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  answerFromCard,
  isCardAnswerable,
  renderReminderCard,
  renderReminderClosedCard,
} from '../../src/host/reminder-card.ts';
import { normalizeQuestions } from '../../src/host/reminder-text.ts';

const OPTIONS = [{ label: '甲' }, { label: '乙' }, { label: '丙', description: '第三个' }];

function questionOf(raw: Record<string, unknown>) {
  return normalizeQuestions([{ id: 'q1', question: '选一个', ...raw }])[0]!;
}

/** 卡片里第 n 个元素；测试只关心结构，不引入平台的类型包。 */
function element(card: Record<string, any>, index: number): Record<string, any> {
  return card.body.elements[index] as Record<string, any>;
}

test('提问卡片：只有单题、有选项、非审批/计划审阅才上卡片', () => {
  assert.equal(isCardAnswerable(normalizeQuestions([{ id: 'q1', question: '选一个', options: OPTIONS }])), true);
  assert.equal(isCardAnswerable(normalizeQuestions([{ id: 'q1', question: '选一个' }])), false);
  assert.equal(
    isCardAnswerable(
      normalizeQuestions([
        { id: 'q1', question: '选一个', options: OPTIONS },
        { id: 'q2', question: '再选一个', options: OPTIONS },
      ]),
    ),
    false,
  );
  assert.equal(
    isCardAnswerable(normalizeQuestions([{ id: 'q1', question: '批准吗', options: OPTIONS, intent: { kind: 'approval' } }])),
    false,
  );
  assert.equal(
    isCardAnswerable(normalizeQuestions([{ id: 'q1', question: '计划', options: OPTIONS, intent: { kind: 'plan-review' } }])),
    false,
  );
  const many = Array.from({ length: 21 }, (_, index) => ({ label: `选项 ${index}` }));
  assert.equal(isCardAnswerable(normalizeQuestions([{ id: 'q1', question: '太多了', options: many }])), false);
});

test('提问卡片：单选渲染成按钮，回调带提醒 id 与下标', () => {
  const card = renderReminderCard({ reminderId: 'lark-q-1', no: 2, question: questionOf({ options: OPTIONS }) });

  assert.equal(card.schema, '2.0');
  assert.equal((card.header as Record<string, any>).title.content, '需要你回答（#2）');
  assert.match(element(card as Record<string, any>, 0).content, /选一个/u);

  // 单选是一行一个选项：点整行就答，描述跟在文案后面。
  const rows = [1, 2, 3].map((index) => element(card as Record<string, any>, index));
  assert.deepEqual(rows.map((row) => row.tag), ['checker', 'checker', 'checker']);
  assert.deepEqual(rows[1]!.behaviors[0].value, { r: 'lark-q-1', q: 'q1', o: 1 });
  assert.match(rows[2]!.text.content, /丙/u);
  assert.match(rows[2]!.text.content, /第三个/u);

  // 「其他」放进一个只含输入框与提交按钮的表单。
  const form = element(card as Record<string, any>, 4);
  assert.equal(form.tag, 'form');
  assert.equal(form.elements[0].name, 'custom_input');
  assert.deepEqual(form.elements[1].behaviors[0].value, { r: 'lark-q-1', q: 'q1', c: 1 });
});

test('提问卡片：多选是每项一个勾选框，提交按钮带回提醒 id', () => {
  const question = questionOf({ options: OPTIONS, multiSelect: true });
  const card = renderReminderCard({ reminderId: 'lark-q-1', no: 1, question });
  const form = element(card as Record<string, any>, 1);

  assert.equal(form.tag, 'form');
  const checkers = (form.elements as Array<Record<string, any>>).filter((item) => item.tag === 'checker');
  assert.deepEqual(checkers.map((item) => item.name), ['answer_0', 'answer_1', 'answer_2']);
  assert.match(checkers[2]!.text.content, /丙/u);

  const submit = (form.elements as Array<Record<string, any>>).at(-1)!;
  assert.equal(submit.tag, 'button');
  assert.equal(submit.form_action_type, 'submit');
  assert.deepEqual(submit.behaviors[0].value, { r: 'lark-q-1', q: 'q1' });

  // 「其他」答案：表单里必须有输入框，否则自由输入没有通道。
  const input = (form.elements as Array<Record<string, any>>).find((item) => item.tag === 'input')!;
  assert.equal(input.name, 'custom_input');
});

test('提问卡片：终态卡没有可点元素，只留题干与结论', () => {
  const card = renderReminderClosedCard({ no: 3, question: questionOf({ options: OPTIONS }), outcome: '已在 Web 端作答。' });
  const elements = (card.body as Record<string, any>).elements as Array<Record<string, any>>;

  assert.equal(elements.length, 2);
  assert.equal(elements[1]!.tag, 'markdown');
  assert.match(elements[1]!.content, /已在 Web 端作答/u);
  assert.equal(JSON.stringify(card).includes('behaviors'), false);
});

test('卡片回调：单选下标、多选数组/逗号串/文案都能还原', () => {
  const single = questionOf({ options: OPTIONS });
  const multi = questionOf({ options: OPTIONS, multiSelect: true });

  assert.deepEqual(answerFromCard(single, { o: 1 }, undefined), { id: 'q1', selected: ['乙'] });
  assert.deepEqual(answerFromCard(single, { o: '2' }, undefined), { id: 'q1', selected: ['丙'] });
  // 表单提交（勾选框）：answer_<下标> 为 true 的项。
  assert.deepEqual(answerFromCard(multi, {}, undefined, { answer_0: true, answer_2: true }), { id: 'q1', selected: ['甲', '丙'] });
  // 下拉版遗留：form_value.answer 数组照样认。
  assert.deepEqual(answerFromCard(multi, {}, undefined, { answer: ['0', '2'] }), { id: 'q1', selected: ['甲', '丙'] });
  // 旧版 option：数组、逗号串、编码过的逗号串与文案都认。
  assert.deepEqual(answerFromCard(multi, {}, ['0', '2']), { id: 'q1', selected: ['甲', '丙'] });
  assert.deepEqual(answerFromCard(multi, {}, '0,2'), { id: 'q1', selected: ['甲', '丙'] });
  assert.deepEqual(answerFromCard(multi, {}, '0%2C2'), { id: 'q1', selected: ['甲', '丙'] });
  assert.deepEqual(answerFromCard(multi, {}, ['甲', '丙']), { id: 'q1', selected: ['甲', '丙'] });
});

test('卡片回调：「其他」输入落成 custom', () => {
  const single = questionOf({ options: OPTIONS });
  const multi = questionOf({ options: OPTIONS, multiSelect: true });

  assert.deepEqual(answerFromCard(single, { c: 1 }, undefined, { custom_input: ' 都不合适 ' }), {
    id: 'q1',
    selected: [],
    custom: '都不合适',
  });
  assert.deepEqual(answerFromCard(multi, {}, undefined, { answer_0: true, custom_input: '补充一句' }), {
    id: 'q1',
    selected: ['甲'],
    custom: '补充一句',
  });
  // 空输入当作没填。
  assert.deepEqual(answerFromCard(multi, {}, undefined, { answer_2: true, custom_input: '   ' }), {
    id: 'q1',
    selected: ['丙'],
  });
});

test('卡片回调：认不出的值不硬解成作答', () => {
  const single = questionOf({ options: OPTIONS });
  const multi = questionOf({ options: OPTIONS, multiSelect: true });

  assert.equal(answerFromCard(single, { o: 9 }, undefined), null);
  assert.equal(answerFromCard(multi, {}, '不存在的选项'), null);
  assert.equal(answerFromCard(multi, {}, undefined), null);
  assert.equal(answerFromCard(multi, {}, undefined, { answer: [] }), null);
});
