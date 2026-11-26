import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Interaction } from '../../src/host/protocol.ts';
import { interactionText, questionHeading, questionMarker, questionTitle } from '../../src/host/question-text.ts';

test('题号：单题不加序号，多题用圆圈序号', () => {
  assert.equal(questionMarker(0, 1), '');
  assert.equal(questionMarker(0, 2), '① ');
  assert.equal(questionMarker(1, 3), '② ');
});

test('标题：有 header 时拼成「标题：题干」，空 header 不拼', () => {
  assert.equal(questionTitle({ id: 'q', question: '选一个' }), '选一个');
  assert.equal(questionTitle({ id: 'q', header: '', question: '选一个' }), '选一个');
  assert.equal(questionTitle({ id: 'q', header: '主角', question: '选一个' }), '主角：选一个');
  assert.equal(questionHeading({ id: 'q', header: '主角', question: '选一个' }, 0, 2), '① 主角：选一个');
});

test('文字形态：纯文本不加粗，Markdown 加粗题干且多选标注留在加粗外', () => {
  const interaction: Interaction = {
    questions: [
      {
        id: 'q1',
        header: '主角',
        question: '选一个',
        multiSelect: true,
        options: [{ label: '甲' }, { label: '乙', description: '第二个' }],
      },
    ],
  };

  const plain = interactionText(interaction, { markdown: false });
  assert.doesNotMatch(plain, /\*\*/u);
  assert.match(plain, /^主角：选一个（可多选）$/mu);
  assert.match(plain, /^1\. 甲$/mu);
  assert.match(plain, /^2\. 乙 — 第二个$/mu);

  const markdown = interactionText(interaction, { markdown: true });
  assert.match(markdown, /^\*\*主角：选一个\*\*（可多选）$/mu);
});

test('文字形态：自由文本题只提示直接回复文字', () => {
  const text = interactionText({ questions: [{ id: 'q', question: '补充说明' }] }, { markdown: false });
  assert.match(text, /补充说明/u);
  assert.match(text, /直接回复文字作答/u);
  assert.doesNotMatch(text, /回复序号选择/u);
});

test('文字形态：审批题提示去 Web 端，且优先于多题指引', () => {
  const text = interactionText(
    {
      questions: [
        { id: 'q1', question: '确认执行？', intent: 'approval' },
        { id: 'q2', question: '备注' },
      ],
    },
    { markdown: false },
  );
  assert.match(text, /包含审批/u);
  assert.match(text, /Web 端/u);
  assert.doesNotMatch(text, /按题目顺序分行/u);
});

test('文字形态：多题按题号与分隔线排开，指引说明分段规则', () => {
  const text = interactionText(
    {
      questions: [
        { id: 'q1', question: '第一题', options: [{ label: '甲' }] },
        { id: 'q2', question: '第二题', detail: '补充说明', options: [{ label: '乙' }] },
      ],
    },
    { markdown: false },
  );
  assert.match(text, /① 第一题/u);
  assert.match(text, /② 第二题/u);
  assert.match(text, /补充说明/u);
  assert.match(text, /按题目顺序分行/u);
  assert.match(text, /段数对不上时整段文字作为每题的答案/u);
});

test('文字形态：没有题目时返回空串', () => {
  assert.equal(interactionText({ questions: [] }, { markdown: true }), '');
});
