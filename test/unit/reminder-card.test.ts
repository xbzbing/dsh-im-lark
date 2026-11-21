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

  const columns = element(card as Record<string, any>, 1).columns as Array<Record<string, any>>;
  assert.equal(columns.length, 3);
  assert.deepEqual(columns[1]!.elements[0].behaviors[0].value, { r: 'lark-q-1', q: 'q1', o: 1 });
  assert.equal(columns[2]!.elements[0].text.content, '丙');
});

test('提问卡片：多选渲染成下拉，回调只带提醒 id 与问题 id', () => {
  const question = questionOf({ options: OPTIONS, multiSelect: true });
  const card = renderReminderCard({ reminderId: 'lark-q-1', no: 1, question });
  const select = element(card as Record<string, any>, 1);

  assert.equal(select.tag, 'multi_select_static');
  assert.deepEqual(select.behaviors[0].value, { r: 'lark-q-1', q: 'q1' });
  assert.deepEqual(select.options.map((option: Record<string, any>) => option.value), ['0', '1', '2']);
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
  assert.deepEqual(answerFromCard(multi, {}, ['0', '2']), { id: 'q1', selected: ['甲', '丙'] });
  assert.deepEqual(answerFromCard(multi, {}, '0,2'), { id: 'q1', selected: ['甲', '丙'] });
  assert.deepEqual(answerFromCard(multi, {}, '0%2C2'), { id: 'q1', selected: ['甲', '丙'] });
  assert.deepEqual(answerFromCard(multi, {}, ['甲', '丙']), { id: 'q1', selected: ['甲', '丙'] });
});

test('卡片回调：认不出的值不硬解成作答', () => {
  const single = questionOf({ options: OPTIONS });
  const multi = questionOf({ options: OPTIONS, multiSelect: true });

  assert.equal(answerFromCard(single, { o: 9 }, undefined), null);
  assert.equal(answerFromCard(multi, {}, '不存在的选项'), null);
  assert.equal(answerFromCard(multi, {}, undefined), null);
});
