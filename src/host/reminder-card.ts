/**
 * 独立模式的提问卡片：宿主问题 → 飞书交互卡片，卡片回调 → 协议作答。
 *
 * 只处理「一道题、有选项、不是审批/计划审阅」这一种：多题与自由输入在卡片里答不完
 * （核心要求一次提交全部问题），仍走文字提醒（`reminder-text.ts`）。卡片只做两件
 * 事——把选项摆出来、把选中的文案还原成作答；状态机与竞答在 `questions.ts`。
 *
 * 回调里的 `value` 用短键（`{r,q,o}`）：卡片体积敏感，且 `value` 必须是对象。
 */

import { cardFits } from './cards.ts';
import type { Card } from './cards.ts';
import type { AskQuestion } from './reminder-text.ts';

export const CARD_SCHEMA = '2.0';

/** 一张卡最多摆多少选项：再多就别指望在 IM 里点得清，退回文字。 */
const MAX_OPTIONS = 20;

/** 这道题能不能用卡片作答。 */
export function isCardAnswerable(questions: readonly AskQuestion[]): boolean {
  if (questions.length !== 1) return false;
  const question = questions[0];
  if (question === undefined) return false;
  const options = question.options ?? [];
  if (options.length === 0 || options.length > MAX_OPTIONS) return false;
  const kind = question.intent?.kind;
  return kind !== 'approval' && kind !== 'plan-review';
}

export interface ReminderCardInput {
  /** 提醒 id：回调里带回来，据此找回待答。 */
  reminderId: string;
  /** 提醒编号（#N），主人回复文字时也用得上。 */
  no: number;
  question: AskQuestion;
}

/** 题目 → 一张可作答的卡片；装不下时由调用方退回文字提醒。 */
export function renderReminderCard(input: ReminderCardInput): Card {
  const { reminderId, no, question } = input;
  const elements: unknown[] = [stemOf(question)];
  const options = question.options ?? [];

  // 飞书卡片没有单选按钮组：单选与多选都用勾选器（checker），靠文案说明区别；
  // 两者都必须点「提交」才生效，值走 form_value.answer_<下标>。
  const instruction = question.multiSelect === true
    ? '多选：可以勾选多项，选好后点「提交」。'
    : '单选：只能勾选一项，选好后点「提交」。';
  elements.push(
    { tag: 'markdown', content: instruction, text_size: 'notation' },
    {
      tag: 'form',
      name: 'ask_form',
      elements: [
        ...options.map((option, index) => ({
          tag: 'checker',
          name: `answer_${index}`,
          checked: false,
          overall_checkable: false,
          text: optionText(option),
        })),
        customInput(),
        submitButton({ r: reminderId, q: question.id }),
      ],
    },
  );

  const card: Card = {
    schema: CARD_SCHEMA,
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `需要你回答（#${no}）` }, template: 'blue' },
    body: { elements },
  };
  // 选项描述会把卡片撑大：装不下就抛给调用方退回文字，别发出半张卡。
  if (!cardFits(card)) throw new RangeError('提问卡片超过体积上限');
  return card;
}

/** 终态卡：保留题干，附上「谁答了/为什么失效」，不再留可点的按钮。 */
export function renderReminderClosedCard(input: { no: number; question: AskQuestion; outcome: string }): Card {
  return {
    schema: CARD_SCHEMA,
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `需要你回答（#${input.no}）` }, template: 'grey' },
    body: {
      elements: [
        stemOf(input.question),
        { tag: 'markdown', content: `_${input.outcome}_`, text_size: 'notation' },
      ],
    },
  };
}

function optionText(option: { label: string; description?: string }): Record<string, unknown> {
  return { tag: 'lark_md', content: `**${option.label}**${option.description === undefined || option.description === '' ? '' : `\n${option.description}`}` };
}

function customInput(): Record<string, unknown> {
  return {
    tag: 'input',
    name: 'custom_input',
    placeholder: { tag: 'plain_text', content: '其他答案（可选）：填写后点提交' },
    width: 'fill',
  };
}

function submitButton(value: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: 'button',
    name: 'ask_submit',
    type: 'primary',
    text: { tag: 'plain_text', content: '提交' },
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value }],
  };
}

function stemOf(question: AskQuestion): Record<string, unknown> {
  const lines = [`**${question.header ?? '需要你回答'}**`, question.question];
  if (question.detail !== undefined && question.detail !== '') lines.push('', question.detail);
  return { tag: 'markdown', content: lines.join('\n'), text_size: 'normal' };
}

/**
 * 卡片回调 → 作答。
 *
 * 与核心桥的约定一致：单选看 `value.o`（下标），多选的 `option` 可能是下标数组、
 * 逗号串或选项文案，三种都认；认不出就返回 null，让调用方当作「不是这条提醒的作答」。
 */
export function answerFromCard(
  question: AskQuestion,
  value: Record<string, unknown>,
  option: unknown,
  formValues?: Record<string, unknown>,
): { id: string; selected: string[]; custom?: string } | null {
  const options = question.options ?? [];
  const labelsOf = (raw: unknown): string[] | undefined => {
    const indices = toIndexList(raw);
    if (indices === undefined) return undefined;
    const labels = indices
      .map((index) => options[index]?.label)
      .filter((label): label is string => label !== undefined && label !== '');
    return labels.length === 0 ? undefined : [...new Set(labels)];
  };

  if (value.o !== undefined) {
    const single = labelsOf([value.o]);
    return single === undefined ? null : { id: question.id, selected: single };
  }

  // 表单提交：勾选框 `answer_<下标>: true`，「其他」答案在 `custom_input`。
  const custom = customOf(formValues);
  const checked = checkedFromForm(formValues);
  if (checked.length > 0 || custom !== undefined) {
    // 单选时「其他」就是答案本身：勾了别的也以输入为准。
    if (question.multiSelect !== true && custom !== undefined) return { id: question.id, selected: [], custom };
    const labels = checked
      .map((index) => options[index]?.label)
      .filter((label): label is string => label !== undefined && label !== '');
    return {
      id: question.id,
      selected: [...new Set(labels)],
      ...(custom === undefined ? {} : { custom }),
    };
  }
  // 下拉版遗留：`form_value.answer` 数组或 behaviors 的 option。
  const multi = labelsOf(formValues?.answer) ?? labelsOf(option);
  if (multi !== undefined) return { id: question.id, selected: multi };

  // 有些客户端直接把选项文案回传，认文案兜底。
  const texts = toTextList(option).filter((text) => options.some((item) => item.label === text));
  return texts.length === 0 ? null : { id: question.id, selected: [...new Set(texts)] };
}

/** 表单里的「其他」输入；空串当没填。 */
export function customOf(formValues: Record<string, unknown> | undefined): string | undefined {
  const raw = formValues?.custom_input;
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text === '' ? undefined : text;
}

/** 表单里勾选框的提交值：`answer_<下标>` 为 true 的按下标返回。 */
function checkedFromForm(formValues: Record<string, unknown> | undefined): number[] {
  if (formValues === undefined) return [];
  const indices: number[] = [];
  for (const [key, value] of Object.entries(formValues)) {
    const match = /^answer_(\d+)$/u.exec(key);
    if (match !== null && value === true) indices.push(Number(match[1]));
  }
  return indices.sort((left, right) => left - right);
}

/** 单选下标、多选下标数组、`"0,2"`、`"0%2C2"` 都收敛成下标数组。 */
function toIndexList(raw: unknown): number[] | undefined {
  if (Array.isArray(raw)) return indicesOf(raw);
  if (typeof raw === 'string') return indicesOf(raw.replace(/%2C/giu, ',').split(','));
  return indicesOf([raw]);
}

function indicesOf(items: readonly unknown[]): number[] | undefined {
  const indices: number[] = [];
  for (const item of items) {
    if (typeof item === 'number' && Number.isInteger(item)) {
      indices.push(item);
      continue;
    }
    if (typeof item === 'string' && /^\d+$/u.test(item.trim())) {
      indices.push(Number(item.trim()));
      continue;
    }
    return undefined;
  }
  return indices.length === 0 ? undefined : indices;
}

function toTextList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  if (typeof raw === 'string') return raw.split(/[,，、]+/u).map((item) => item.trim()).filter(Boolean);
  return [];
}
