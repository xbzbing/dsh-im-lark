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

import { CARD_BODY_BYTES_MAX } from '../shared/limits.ts';
import type { Interaction, InteractionAnswerDraft, InteractionAnswerItem, InteractionQuestion, Delivery } from './protocol.ts';
import type { RejectReason } from './protocol.ts';

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
  return cardBytes(card) <= CARD_BODY_BYTES_MAX;
}

/** 消息体：`content` 字段要的是 JSON 字符串，不是对象。 */
export function cardContent(card: unknown): string {
  return JSON.stringify(card);
}

function optionText(option: { label: string; description?: string }): Record<string, unknown> {
  const content = option.description === undefined || option.description === ''
    ? `**${option.label}**`
    : `**${option.label}**\n${option.description}`;
  return { tag: 'lark_md', content };
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
      for (const question of interaction.questions) {
        elements.push({ tag: 'markdown', content: `**${question.header ?? '请选择'}**\n${question.question}`, text_size: 'normal' });
      }
      elements.push({
        tag: 'markdown',
        content: '_这条交互包含多个问题，或需要审批/自定义输入；请在 DeepSeek Harness Web 端作答，审批也在 Web 端处理。_',
        text_size: 'notation',
      });
    } else {
      for (const question of interaction.questions) {
        elements.push(...renderQuestion(delivery.id, question));
      }
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
 * 核心要求一次提交全部问题；多问题时用户没法在一张卡上「先答一题、再答一题」，
 * 所以只对单问题、非审批、且有选项的交互渲染按钮；其余明确引导去 Web 端。
 */
export function isAnswerable(interaction: Interaction): boolean {
  if (interaction.questions.length !== 1) return false;
  const question = interaction.questions[0]!;
  return question.intent !== 'approval' && (question.options?.length ?? 0) > 0;
}

/** 一个问题：题干 + 选项按钮；审批类只提示、不给按钮。 */
function renderQuestion(deliveryId: string, question: InteractionQuestion): unknown[] {
  const label = question.header ?? '请选择';
  const elements: unknown[] = [
    { tag: 'markdown', content: `**${label}**\n${question.question}`, text_size: 'normal' },
  ];

  if (question.intent === 'approval') {
    elements.push({ tag: 'markdown', content: '_审批请在 DeepSeek Harness Web 端处理。_', text_size: 'notation' });
    return elements;
  }

  const options = question.options ?? [];
  if (options.length === 0) return elements;

  if (question.multiSelect === true) {
    // 飞书的下拉多选只能嵌在表单容器里，且必须有一个 form_action_type=submit 的
    // 提交按钮：选中值走回调的 `form_value.answer`，不是下拉自身的 behaviors。
    // 没有提交按钮时，用户勾完没有任何东西可点（真机踩过）。
    elements.push({
      tag: 'form',
      name: 'ask_form',
      elements: [
        // 每个选项一个勾选框（checker）：飞书卡片没有「多选框组」，下拉多选不像多选。
        // 勾选值随表单提交走 form_value.answer_<下标>，按钮上带交付/问题 id。
        ...options.map((option, index) => ({
          tag: 'checker',
          name: `answer_${index}`,
          checked: false,
          overall_checkable: false,
          text: optionText(option),
        })),
        customInput(),
        submitButton({ d: deliveryId, q: question.id }),
      ],
    });
    return elements;
  }

  // 单选：一行一个选项（飞书卡片没有原生单选框组），点整行就作答；
  // 描述与文案一起展示；「其他」答案走表单提交。
  elements.push(
    ...options.map((option, index) => ({
      tag: 'checker',
      name: `answer_${index}`,
      checked: false,
      overall_checkable: true,
      text: optionText(option),
      behaviors: [{ type: 'callback', value: { d: deliveryId, q: question.id, o: index } }],
    })),
    {
      tag: 'form',
      name: 'ask_form',
      elements: [customInput(), submitButton({ d: deliveryId, q: question.id, c: 1 })],
    },
  );
  return elements;
}

/** 已作答的卡：保留正文与题干，附上选择结果，不再有按钮。 */
export function renderAnsweredCard(delivery: Delivery, answers: readonly InteractionAnswerItem[]): Card {
  const card = renderDeliveryCard(delivery, { interactive: false });
  const body = card.body as { elements: unknown[] };
  const lines = answers.map((answer) => {
    const question = delivery.interaction?.questions.find((item) => item.id === answer.id);
    const chosen = answer.selected.length > 0 ? answer.selected.join('、') : answer.custom ?? '（自定义）';
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
 * 把按钮回调翻译成协议里的作答。
 *
 * 约定：
 * - value 里的 `d`/`q`/`o` 是我们自己写的，短键省卡片体积；
 * - 多选的 `action.option` 可能是单个值、逗号串或数组，三种都认；
 * - 审批类一律 `not-allowed`（协议里 IM 不代答审批）。
 */
export function answerFromAction(
  value: Record<string, unknown>,
  option: unknown,
  formValues: Record<string, unknown> | undefined,
  sender: string,
  store: InteractionStore,
  now: number,
): InteractionAnswerDraft | { reason: RejectReason; detail?: string } {
  const deliveryId = typeof value.d === 'string' ? value.d : '';
  const questionId = typeof value.q === 'string' ? value.q : '';
  if (deliveryId === '' || questionId === '') return { reason: 'invalid', detail: '回调缺少交付或问题 id' };

  const pending = store.get(deliveryId);
  if (pending === undefined) return { reason: 'unknown', detail: '交付已不在内存里（可能已重启）' };
  if (pending.answered) return { reason: 'settled', detail: '这条已经作答' };
  if (pending.expiresAt !== undefined && pending.expiresAt <= now) return { reason: 'expired' };

  const question = pending.questions.find((item) => item.id === questionId);
  if (question === undefined) return { reason: 'invalid', detail: '问题不在这次交付里' };
  if (question.intent === 'approval') return { reason: 'not-allowed', detail: '审批请在 Web 端处理' };

  const selected = resolveSelection(question, value, option, formValues);
  if (selected === undefined) return { reason: 'invalid-answer', detail: '无法从回调里认出选项' };

  return {
    deliveryId,
    sender,
    answers: [{
      id: question.id,
      selected: selected.selected,
      ...(selected.custom === undefined ? {} : { custom: selected.custom }),
    }],
    at: now,
  };
}

/** 把按钮 index / 多选值还原成选项文案。 */
function resolveSelection(
  question: InteractionQuestion,
  value: Record<string, unknown>,
  option: unknown,
  formValues: Record<string, unknown> | undefined,
): { selected: string[]; custom?: string } | undefined {
  const options = question.options ?? [];
  const fromIndices = (raw: unknown): string[] | undefined => {
    const indices = toIndexList(raw);
    if (indices === undefined) return undefined;
    const labels = indices.map((index) => options[index]?.label).filter((label): label is string => label !== undefined);
    return labels.length === 0 ? undefined : labels;
  };

  if (typeof value.o === 'number') return pick(fromIndices([value.o]));
  if (typeof value.o === 'string') return pick(fromIndices([value.o]));

  // 表单提交（勾选框 + 「其他」输入）：answer_<下标> 为 true，custom_input 为自由文本。
  const custom = customOf(formValues);
  if (formValues !== undefined) {
    const checked = Object.entries(formValues)
      .filter(([key, value]) => /^answer_(\d+)$/u.test(key) && value === true)
      .map(([key]) => Number(key.slice('answer_'.length)))
      .filter((index) => options[index] !== undefined)
      .sort((left, right) => left - right);
    if (checked.length > 0 || custom !== undefined) {
      return { selected: checked.map((index) => options[index]!.label), ...(custom === undefined ? {} : { custom }) };
    }
  }
  const fromForm = formValues?.answer;
  if (fromForm !== undefined) {
    const labels = fromIndices(fromForm);
    if (labels !== undefined) return pick(labels);
  }

  // 多选：数组优先；字符串可能是 "0,2"、"0%2C2" 或单个值。
  const multi = fromIndices(option);
  if (multi !== undefined) return pick(multi);

  // 有些客户端直接把选项文案回传，认文案兜底。
  const labels = toStringList(option).filter((text) => options.some((item) => item.label === text));
  return pick(labels.length === 0 ? undefined : labels);
}

function pick(selected: string[] | undefined): { selected: string[] } | undefined {
  return selected === undefined ? undefined : { selected };
}

/** 表单里「其他」输入：空串当没填。 */
function customOf(formValues: Record<string, unknown> | undefined): string | undefined {
  const raw = formValues?.custom_input;
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text === '' ? undefined : text;
}

function toIndexList(raw: unknown): number[] | undefined {
  const items = Array.isArray(raw) ? raw : [raw];
  const indices: number[] = [];

  for (const item of items) {
    if (typeof item === 'number') {
      if (!Number.isInteger(item) || item < 0) return undefined;
      indices.push(item);
      continue;
    }
    if (typeof item !== 'string') continue;
    for (const text of item.split(',')) {
      const trimmed = text.trim();
      if (trimmed === '') continue;
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 0) return undefined;
      indices.push(parsed);
    }
  }
  return indices.length === 0 ? undefined : indices;
}

function toStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  if (typeof raw === 'string') return raw.split(',').map((item) => item.trim());
  return [];
}
