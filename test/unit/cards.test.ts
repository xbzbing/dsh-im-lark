import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InteractionStore,
  answerFromAction,
  cardBytes,
  cardFits,
  renderAnsweredCard,
  renderDeliveryCard,
  renderMarkdownCard,
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

function buttonsOf(card: unknown): Array<{ text: { content: string }; behaviors: Array<{ value: Record<string, unknown> }> }> {
  const shape = card as CardShape;
  const columns = shape.body.elements.find((element) => element.tag === 'column_set') as
    | { columns: Array<{ elements: Array<{ text: { content: string }; behaviors: Array<{ value: Record<string, unknown> }> }> }> }
    | undefined;
  return columns?.columns.map((column) => column.elements[0]!) ?? [];
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

test('交付卡：单选每题一个按钮，value 带交付、问题与序号', () => {
  const card = renderDeliveryCard(
    {
      ...DELIVERY,
      interaction: { questions: [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }] },
    },
    { interactive: true },
  );

  const buttons = buttonsOf(card);
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons[0]!.behaviors[0]!.value, { d: 'dlv_1', q: 'q1', o: 0 });
  assert.equal(buttons[1]!.text.content, '乙');
});

test('交付卡：多选用 multi_select_static，值用序号避免文案里的逗号歧义', () => {
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

  const select = form.elements.find((element) => element.tag === 'multi_select_static') as
    | { name: string; options: Array<{ value: string; text: { content: string } }> }
    | undefined;
  assert.ok(select !== undefined);
  assert.equal(select.name, 'answer');
  assert.deepEqual(select.options.map((option) => option.value), ['0', '1']);
  assert.equal(select.options[0]!.text.content, '甲,乙');

  // 没有提交按钮时勾完无处可点：按钮必须带 form_action_type=submit 并携带交付/问题 id。
  const submit = form.elements.find((element) => element.tag === 'button') as
    | { form_action_type: string; behaviors: Array<{ value: Record<string, unknown> }> }
    | undefined;
  assert.ok(submit !== undefined);
  assert.equal(submit.form_action_type, 'submit');
  assert.deepEqual(submit.behaviors[0]!.value, { d: 'dlv_1', q: 'q2' });
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

  assert.equal(buttonsOf(card).length, 0);
  assert.match(JSON.stringify(card), /Web 端处理/);
});

test('交付卡：多问题不在 IM 里拆答，给出 Web 端提示', () => {
  const card = renderDeliveryCard(
    {
      ...DELIVERY,
      interaction: {
        questions: [
          { id: 'q1', question: '第一题', options: [{ label: '甲' }, { label: '乙' }] },
          { id: 'q2', question: '第二题', options: [{ label: '丙' }] },
        ],
      },
    },
    { interactive: true },
  );

  assert.equal(buttonsOf(card).length, 0);
  assert.match(JSON.stringify(card), /第一题/);
  assert.match(JSON.stringify(card), /Web 端作答/);
});

test('已作答卡：不再有按钮，附上选择结果', () => {
  const delivery: Delivery = {
    ...DELIVERY,
    interaction: { questions: [{ id: 'q1', header: '问题', question: '选一个', options: [{ label: '甲' }] }] },
  };
  const card = renderAnsweredCard(delivery, [{ id: 'q1', selected: ['甲'] }]);

  assert.equal(buttonsOf(card).length, 0);
  assert.match(JSON.stringify(card), /已作答/);
  assert.match(JSON.stringify(card), /问题：甲/);
});

test('被替代卡：明确说明不再有效', () => {
  assert.match(JSON.stringify(renderSupersededCard(DELIVERY)), /已被新卡片替代/);
});

test('卡片体积：超过上限时 cardFits 为 false', () => {
  const big = renderMarkdownCard('汉'.repeat(20_000));
  assert.equal(cardBytes(big) > 28 * 1024, true);
  assert.equal(cardFits(big), false);
  assert.equal(cardFits(renderMarkdownCard('短')), true);
});

/** 造一份待作答记录。 */
function storeWith(question: InteractionQuestion, overrides: Partial<{ answered: boolean; expiresAt: number }> = {}): InteractionStore {
  const store = new InteractionStore();
  store.add({
    deliveryId: 'dlv_1',
    chatId: 'oc_1',
    messageId: 'om_1',
    questions: [question],
    createdAt: 0,
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    answered: overrides.answered ?? false,
  });
  return store;
}

const CHOICE: InteractionQuestion = { id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] };

test('作答：按钮回传序号 → 选项文案', () => {
  const store = storeWith(CHOICE);
  const result = answerFromAction({ d: 'dlv_1', q: 'q1', o: 1 }, undefined, undefined, 'ou_owner', store, 10);
  assert.ok(!('reason' in result));
  assert.deepEqual(result.answers, [{ id: 'q1', selected: ['乙'] }]);
  assert.equal(result.sender, 'ou_owner');
});

test('作答：多选接受数组、逗号串与单值', () => {
  const multi: InteractionQuestion = { ...CHOICE, id: 'q2', multiSelect: true };

  for (const option of [['0', '1'], '0,1', [0, 1]]) {
    const store = storeWith(multi);
    const result = answerFromAction({ d: 'dlv_1', q: 'q2' }, option, undefined, 'ou', store, 0);
    assert.ok(!('reason' in result), `option=${JSON.stringify(option)}`);
    assert.deepEqual(result.answers[0]!.selected, ['甲', '乙']);
  }
});

test('作答：多选表单提交读 form_value.answer', () => {
  const multi: InteractionQuestion = { ...CHOICE, id: 'q2', multiSelect: true };
  const store = storeWith(multi);
  const result = answerFromAction({ d: 'dlv_1', q: 'q2' }, undefined, { answer: ['1', '0'] }, 'ou', store, 0);
  assert.ok(!('reason' in result));
  assert.deepEqual(result.answers[0]!.selected, ['乙', '甲']);
});

test('作答：客户端回传文案时按文案兜底', () => {
  const store = storeWith(CHOICE);
  const result = answerFromAction({ d: 'dlv_1', q: 'q1' }, '乙', undefined, 'ou', store, 0);
  assert.ok(!('reason' in result));
  assert.deepEqual(result.answers[0]!.selected, ['乙']);
});

test('作答：已作答、过期、未知交付、审批分别给出协议原因', () => {
  assert.equal(reasonOf(storeWith(CHOICE, { answered: true }), { d: 'dlv_1', q: 'q1', o: 0 }), 'settled');
  assert.equal(reasonOf(storeWith(CHOICE, { expiresAt: 5 }), { d: 'dlv_1', q: 'q1', o: 0 }, 10), 'expired');
  assert.equal(reasonOf(new InteractionStore(), { d: 'dlv_x', q: 'q1' }), 'unknown');
  assert.equal(
    reasonOf(storeWith({ ...CHOICE, intent: 'approval' }), { d: 'dlv_1', q: 'q1', o: 0 }),
    'not-allowed',
  );
});

test('作答：缺少标识或选项越界都算无效', () => {
  const store = storeWith(CHOICE);
  assert.equal(reasonOf(store, {}), 'invalid');
  assert.equal(reasonOf(store, { d: 'dlv_1', q: 'q1', o: 9 }), 'invalid-answer');
});

function reasonOf(store: InteractionStore, value: Record<string, unknown>, now = 0): string {
  const result = answerFromAction(value, undefined, undefined, 'ou', store, now);
  return 'reason' in result ? result.reason : 'accepted';
}
