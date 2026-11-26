/**
 * 卡片 JSON 构造与交互状态。
 *
 * 回答统一走**卡片**而不是纯文本：飞书文本消息不渲染 Markdown，卡片里的
 * `markdown` 组件才认标题、列表、表格与代码块。代价是体积上限更小（30 KB），
 * 所以发送前要按字节再卡一道（`outbound.ts`）。
 *
 * 结构以卡片 JSON 2.0 为准（`"schema": "2.0"` + `body.elements`），仅支持共享
 * 卡片，因此 `update_multi` 恒为 `true`，后续才能原地 PATCH。
 *
 * 交互按钮把 `value` 收敛成短键对象（`{d,q,o}`）：卡片体积敏感，且 `value`
 * 必须是对象（平台硬要求）。
 */

import { CARD_BODY_BYTES_MAX, CARD_COMPONENTS_MAX } from '../shared/limits.ts';
import type { Interaction, InteractionAnswerDraft, InteractionAnswerItem, InteractionQuestion, Delivery } from './protocol.ts';
import type { RejectReason } from './protocol.ts';
import { interactionText, multiSelectSuffix, questionHeading } from './question-text.ts';

export const CARD_SCHEMA = '2.0';

/** 卡片模板色：只用平台内置枚举，别传自定义色值。 */
export type CardTemplate =
  | 'blue'
  | 'wathet'
  | 'turquoise'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'carmine'
  | 'violet'
  | 'purple'
  | 'indigo'
  | 'grey';

export interface MarkdownCardOptions {
  /** 卡片标题；不传则没有头部，纯内容卡。 */
  title?: string;
  template?: CardTemplate;
  /** 流式更新模式；流式回答用，普通交付关掉。 */
  streaming?: boolean;
}

export type Card = Record<string, unknown>;

/** 一张只含 Markdown 的卡片。 */
export function renderMarkdownCard(markdown: string, options: MarkdownCardOptions = {}): Card {
  return {
    schema: CARD_SCHEMA,
    config: { update_multi: true, ...(options.streaming === true ? { streaming_mode: true } : {}) },
    ...headerOf(options),
    body: { elements: [{ tag: 'markdown', content: markdown, text_size: 'normal' }] },
  };
}

/** 卡片序列化后的字节数（UTF-8），发送前用于判断是否超限。 */
export function cardBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}

export function cardFits(card: unknown): boolean {
  return cardBytes(card) <= CARD_BODY_BYTES_MAX && cardComponents(card) <= CARD_COMPONENTS_MAX;
}

/** 组件数：数所有带 `tag` 的对象（含 form 里的子控件），比平台口径略保守。 */
export function cardComponents(card: unknown): number {
  let count = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (typeof record.tag === 'string') count += 1;
    for (const value of Object.values(record)) walk(value);
  };
  walk(card);
  return count;
}

/** 消息体：`content` 字段要的是 JSON 字符串，不是对象。 */
export function cardContent(card: unknown): string {
  return JSON.stringify(card);
}

function optionText(option: { label: string; description?: string }): Record<string, unknown> {
  return { tag: 'lark_md', content: `**${option.label}**${option.description === undefined || option.description === '' ? '' : `\n${option.description}`}` };
}

/** 勾选器名：`answer_<题号>_<选项号>`。多题共用一张 form，题号让 name 全卡唯一。 */
function checkerName(questionIndex: number, optionIndex: number): string {
  return `answer_${questionIndex}_${optionIndex}`;
}

/** 自由文本输入名：无选项的题、以及有选项时的「其他」都用它。 */
function inputName(questionIndex: number): string {
  return `custom_${questionIndex}`;
}

function customInput(
  name: string,
  placeholder = '其他答案（可选）：填写后点提交',
  value?: string,
): Record<string, unknown> {
  return {
    tag: 'input',
    name,
    placeholder: { tag: 'plain_text', content: placeholder },
    width: 'fill',
    // 重画时回填已填内容；`default_value` 是官方 input 字段（见 docs/protocol）。
    ...(value === undefined ? {} : { default_value: value }),
  };
}

/** 表单值里的自由文本：空串、全空白、非字符串都当没填。 */
function trimText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text === '' ? undefined : text;
}

function submitButton(value: Record<string, unknown>, label = '提交'): Record<string, unknown> {
  return {
    tag: 'button',
    name: 'ask_submit',
    type: 'primary',
    text: { tag: 'plain_text', content: label },
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value }],
  };
}

function headerOf(options: MarkdownCardOptions): Record<string, unknown> {
  if (options.title === undefined || options.title === '') return {};
  return {
    header: {
      title: { tag: 'plain_text', content: options.title },
      template: options.template ?? 'blue',
    },
  };
}

/* ------------------------------------------------------------------ 交付卡片 */

export interface DeliveryCardOptions {
  /** 交互状态；有它才渲染按钮。 */
  interaction?: Interaction;
  /** 是否渲染按钮；流式更新与已作答的终态卡传 false。 */
  interactive?: boolean;
  /** 重画时回填的表单值（`answer_*` / `custom_*`）；只有重试卡需要。 */
  formValues?: Record<string, unknown>;
}

/**
 * 把一条交付渲染成卡片：标题 + 正文 + 详情 + 参考 + 交互按钮。
 *
 * 已作答的终态卡不渲染按钮：共享卡片所有人可见，留着一个还能点的按钮会让
 * 「谁点的算数」变得含糊。
 */
export function renderDeliveryCard(delivery: Delivery, options: DeliveryCardOptions = {}): Card {
  const elements: unknown[] = [];
  const body = [delivery.body];
  if (delivery.detail !== undefined && delivery.detail !== '') body.push(['---', '', delivery.detail].join('\n'));
  if (delivery.refs !== undefined && delivery.refs.length > 0) {
    body.push(['参考：', ...delivery.refs.map((ref) => `- ${ref.title ?? ref.id}`)].join('\n'));
  }
  elements.push({ tag: 'markdown', content: body.join('\n\n'), text_size: 'normal' });

  const interaction = options.interaction ?? delivery.interaction;
  if (options.interactive !== false && interaction !== undefined) {
    if (!isAnswerable(interaction)) {
      // 不能在 IM 作答的交互也要把题目、选项与回复指引交代清楚：
      // 光给题干，用户既看不到选项，也不知道该去哪、怎么回。
      elements.push({ tag: 'markdown', content: interactionText(interaction, { markdown: true }), text_size: 'normal' });
    } else {
      elements.push({
        tag: 'form',
        name: 'ask_form',
        elements: formElements(delivery.id, interaction.questions, options.formValues),
      });
    }
  }

  return {
    schema: CARD_SCHEMA,
    config: { update_multi: true },
    ...headerOf({ title: delivery.title }),
    body: { elements },
  };
}

/**
 * 这套交互能不能在飞书卡片里答完。
 *
 * 核心要求一次提交全部问题，所以多题必须收进**同一张 form** 一次提交（协议上限
 * 10 题）。审批不代答；超出上限的交回 Web 端。无选项的题用输入框收自定义答案：
 * 核心的桥路校验（`validateAnswer`）接受非空 custom。
 */
export const MAX_ANSWER_QUESTIONS = 10;

export function isAnswerable(interaction: Interaction): boolean {
  const { questions } = interaction;
  if (questions.length === 0 || questions.length > MAX_ANSWER_QUESTIONS) return false;
  return questions.every((question) => question.intent !== 'approval');
}

/** 一道题在 form 里的部分：题干 + 详情 + 单双选说明 + 勾选器（或输入框）。 */
function questionFormPart(
  question: InteractionQuestion,
  index: number,
  total: number,
  formValues: Record<string, unknown> | undefined,
): unknown[] {
  const custom = trimText(formValues?.[inputName(index)]);
  const parts: unknown[] = [
    {
      tag: 'markdown',
      content: `**${questionHeading(question, index, total)}**${multiSelectSuffix(question)}`,
      text_size: 'normal',
    },
  ];
  if (question.detail !== undefined && question.detail !== '') {
    parts.push({ tag: 'markdown', content: question.detail, text_size: 'normal' });
  }

  const options = question.options ?? [];
  if (options.length === 0) {
    parts.push({ tag: 'markdown', content: '直接在下方输入框作答，填好后点「提交」。', text_size: 'notation' });
    parts.push(customInput(inputName(index), '在这里作答：填写后点提交', custom));
    return parts;
  }

  // 飞书卡片没有单选按钮组：单选和多选都用勾选器，靠文案说明区别，
  // 两者都必须点「提交」才生效（值走 form_value.answer_<题号>_<选项号>）。
  parts.push({
    tag: 'markdown',
    content: question.multiSelect === true
      ? '多选：可以勾选多项，选好后点「提交」。'
      : '单选：只能勾选一项，选好后点「提交」。',
    text_size: 'notation',
  });
  options.forEach((option, optionIndex) => {
    parts.push({
      tag: 'checker',
      name: checkerName(index, optionIndex),
      checked: formValues?.[checkerName(index, optionIndex)] === true,
      overall_checkable: false,
      text: optionText(option),
    });
  });
  parts.push(customInput(inputName(index), undefined, custom));
  return parts;
}

/**
 * 整个交互的 form：所有题目的控件收在同一张表单里，一个「提交」按钮整卡提交。
 *
 * form 容器只能放在卡片根部，所以题干也进 form；控件 `name` 全卡唯一，用题号区分。
 */
function formElements(
  deliveryId: string,
  questions: readonly InteractionQuestion[],
  formValues: Record<string, unknown> | undefined,
): unknown[] {
  const elements: unknown[] = [];
  questions.forEach((question, index) => elements.push(...questionFormPart(question, index, questions.length, formValues)));
  elements.push(submitButton({ d: deliveryId }, questions.length > 1 ? `提交 ${questions.length} 题答案` : '提交'));
  return elements;
}

/** 已作答的卡：保留正文与题干，附上选择结果，不再有按钮。 */
export function renderAnsweredCard(delivery: Delivery, answers: readonly InteractionAnswerItem[]): Card {
  const card = renderDeliveryCard(delivery, { interactive: false });
  const body = card.body as { elements: unknown[] };
  const lines = answers.map((answer) => {
    const question = delivery.interaction?.questions.find((item) => item.id === answer.id);
    // 勾选与「其他」可能同时存在（多选），两段都要展示，不能只留勾选。
    const chosen = [answer.selected.join('、'), answer.custom]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('；') || '（未填写）';
    return `- ${question?.header ?? question?.question ?? answer.id}：${chosen}`;
  });
  body.elements.push({ tag: 'markdown', content: ['---', '', '**已作答**', ...lines].join('\n'), text_size: 'normal' });
  return card;
}

/** 被 `supersedes` 替代的卡：明确告诉用户这张不作数了。 */
export function renderSupersededCard(delivery: Delivery): Card {
  const card = renderDeliveryCard(delivery, { interactive: false });
  const body = card.body as { elements: unknown[] };
  body.elements.push({ tag: 'markdown', content: '_这条已过期，已被新卡片替代。_', text_size: 'notation' });
  return card;
}

/**
 * 作答被拒但还能重来的卡：保留勾选框与提交按钮，附上原因。
 *
 * 飞书的表单提交是一次性的——提交之后这张卡的控件不会再触发回调，只有整卡改写才
 * 回到可用状态（官方「表单提交后更新为已提交卡片」的同一套做法）。所以拒绝时不能只
 * 发一句提示，得把这张卡本身重画一遍。
 */
export function renderRetryCard(delivery: Delivery, note: string, formValues?: Record<string, unknown>): Card {
  const card = renderDeliveryCard(delivery, {
    interactive: true,
    ...(formValues === undefined ? {} : { formValues }),
  });
  const body = card.body as { elements: unknown[] };
  body.elements.push({ tag: 'markdown', content: `_**${note}**_`, text_size: 'notation' });
  return card;
}

/**
 * 作答被拒且这张卡不能再答的终态：去掉按钮，写清为什么。
 *
 * 留着一排还能点的勾选框，用户只会反复点、反复被拒，还以为插件坏了。
 */
export function renderRejectedCard(delivery: Delivery, note: string): Card {
  const card = renderDeliveryCard(delivery, { interactive: false });
  const body = card.body as { elements: unknown[] };
  body.elements.push({ tag: 'markdown', content: `_${note}_`, text_size: 'notation' });
  return card;
}

/* ------------------------------------------------------------------ 交互状态 */

export interface PendingInteraction {
  deliveryId: string;
  chatId: string;
  /** 卡片所在消息 id；PATCH 终态用。 */
  messageId: string;
  questions: readonly InteractionQuestion[];
  createdAt: number;
  expiresAt?: number;
  answered: boolean;
}

/**
 * 未作答的交互卡。
 *
 * 只在内存里：进程重启后按钮点下去会找不到上下文，回「已过期」比乱答安全。
 */
export class InteractionStore {
  readonly #byDelivery = new Map<string, PendingInteraction>();
  readonly #max: number;

  constructor(options: { max?: number } = {}) {
    this.#max = options.max ?? 500;
  }

  add(entry: PendingInteraction): void {
    // 先删再插：命中不会把旧待作答卡顶到淘汰位。
    this.#byDelivery.delete(entry.deliveryId);
    this.#byDelivery.set(entry.deliveryId, entry);
    while (this.#byDelivery.size > this.#max) {
      const oldest = this.#byDelivery.keys().next();
      if (oldest.done) break;
      this.#byDelivery.delete(oldest.value);
    }
  }

  get(deliveryId: string): PendingInteraction | undefined {
    return this.#byDelivery.get(deliveryId);
  }

  markAnswered(deliveryId: string): void {
    const entry = this.#byDelivery.get(deliveryId);
    if (entry !== undefined) entry.answered = true;
  }

  delete(deliveryId: string): void {
    this.#byDelivery.delete(deliveryId);
  }

  clear(): void {
    this.#byDelivery.clear();
  }

  get size(): number {
    return this.#byDelivery.size;
  }
}

/**
 * 把表单提交翻译成协议里的作答：一道题一个答项，**一次提交必须答完全部题目**。
 *
 * 约定：
 * - value 里的 `d` 是交付 id（短键省卡片体积，且 value 必须是对象）；
 * - 勾选值在 `form_value.answer_<题号>_<选项号>`，自由文本在 `form_value.custom_<题号>`；
 * - 单选有「其他」时以自由文本为准（勾选项忽略，与旧版一致）；多选可与勾选并存；
 * - 少答、单选勾多项都在这里拒绝并指出题号，桥把原因写回卡片让用户重填；
 * - 审批类不会被登记为可作答（见 `isAnswerable`），真出现就跳过它。
 */
export function answerFromAction(
  value: Record<string, unknown>,
  formValues: Record<string, unknown> | undefined,
  sender: string,
  store: InteractionStore,
  now: number,
): InteractionAnswerDraft | { reason: RejectReason; detail?: string } {
  const deliveryId = typeof value.d === 'string' ? value.d : '';
  if (deliveryId === '') return { reason: 'invalid', detail: '这张卡的作答信息不完整，请在 Web 端重新作答。' };

  const pending = store.get(deliveryId);
  if (pending === undefined) return { reason: 'unknown', detail: '这张卡已经失效（插件重启过），请在 Web 端重新作答。' };
  if (pending.answered) return { reason: 'settled', detail: '这条已经作答' };
  if (pending.expiresAt !== undefined && pending.expiresAt <= now) return { reason: 'expired' };
  if (formValues === undefined) return { reason: 'invalid-answer', detail: '没收到表单内容，请重新提交；或到 Web 端作答。' };

  const answers: InteractionAnswerItem[] = [];
  const missing: number[] = [];
  const singleOverflows: number[] = [];

  pending.questions.forEach((question, index) => {
    if (question.intent === 'approval') return;
    const options = question.options ?? [];
    const checked = options
      .map((option, optionIndex) => (formValues[checkerName(index, optionIndex)] === true ? option.label : undefined))
      .filter((label): label is string => label !== undefined);
    const custom = trimText(formValues[inputName(index)]);
    // 单选的「其他」是替代项：填了就只交 custom，勾选不再参与校验。
    const customOnly = question.multiSelect !== true && custom !== undefined;

    if (!customOnly && options.length > 0 && question.multiSelect !== true && checked.length > 1) {
      singleOverflows.push(index + 1);
    }
    if (checked.length === 0 && custom === undefined) {
      missing.push(index + 1);
      return;
    }
    answers.push({
      id: question.id,
      selected: customOnly ? [] : checked,
      ...(custom === undefined ? {} : { custom }),
    });
  });

  if (singleOverflows.length > 0) {
    return {
      reason: 'invalid-answer',
      detail: `第 ${singleOverflows.join('、')} 题是单选题，只能勾选一项`,
    };
  }
  if (missing.length > 0) {
    return { reason: 'invalid-answer', detail: `第 ${missing.join('、')} 题还没有作答；勾选或填写后点「提交」` };
  }
  return { deliveryId, sender, answers, at: now };
}
