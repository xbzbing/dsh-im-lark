/**
 * 题目与选项的文字形态：卡片装不下、或交互不能在 IM 作答时的兜底呈现。
 *
 * 提示语与核心 `answerFromText` 的匹配规则逐条对齐（多题按「；」「。」或换行分段，
 * 段数与题数一致时一段对应一题），改一边必须改另一边——提示怎么回，核心才怎么认。
 */
import type { Interaction, InteractionQuestion } from './protocol.ts';

const CIRCLED_NUMBERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

/** 多题时题目用圆圈序号、选项用纯数字：两层都是「1.」时分不清在给哪一层回复。 */
export function questionMarker(index: number, total: number): string {
  if (total <= 1) return '';
  return `${CIRCLED_NUMBERS[index] ?? `${index + 1}.`} `;
}

/** 题目标题：有标题用「标题：题干」，没有就只用题干。 */
export function questionTitle(question: InteractionQuestion): string {
  return question.header === undefined || question.header === ''
    ? question.question
    : `${question.header}：${question.question}`;
}

/**
 * 题目抬头的主体：序号 + 标题，不加粗也不带多选标注——卡片侧自己包 `**`，
 * 标注留在加粗之外（与核心 `interactionMarkdown` 的形态一致）。
 */
export function questionHeading(question: InteractionQuestion, index: number, total: number): string {
  return `${questionMarker(index, total)}${questionTitle(question)}`;
}

/** 多选题的标注；单选题返回空串。 */
export function multiSelectSuffix(question: InteractionQuestion): string {
  return question.multiSelect === true ? '（可多选）' : '';
}

/** 表单值里的自由文本：空串、全空白、非字符串都当没填。 */
export function trimText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text === '' ? undefined : text;
}

/** 单题的回复指引；与核心 `interactionMarkdown` 的结尾保持一致。 */
function guidance(interaction: Interaction): string {
  const { questions } = interaction;
  if (questions.some((question) => question.intent === 'approval')) {
    return '这条交互包含审批，请在 DeepSeek Harness Web 端作答，审批也在 Web 端处理。';
  }
  if (questions.length > 1) {
    return '按题目顺序分行（或用「；」「。」分隔）回复，每段对应一题，可写序号或选项；段数对不上时整段文字作为每题的答案。';
  }
  const question = questions[0];
  if (question !== undefined && (question.options ?? []).length === 0) {
    return '直接回复文字作答。';
  }
  return '回复序号选择（多选用逗号分隔），或直接回复文字作答。';
}

/**
 * 交互的文字形态：题目、选项与结尾的回复指引。
 *
 * `markdown` 控制加粗标记——飞书**文本**消息不渲染 Markdown，纯文本形态下
 * 星号只会原样显示（卡片里的 markdown 组件才认）。
 */
export function interactionText(interaction: Interaction, options: { markdown: boolean }): string {
  const { questions } = interaction;
  if (questions.length === 0) return '';
  const bold = (text: string): string => (options.markdown ? `**${text}**` : text);
  const lines: string[] = [];

  questions.forEach((question, index) => {
    if (index > 0) lines.push('---', '');
    lines.push(`${bold(questionHeading(question, index, questions.length))}${multiSelectSuffix(question)}`);
    if (question.detail !== undefined && question.detail !== '') lines.push('', question.detail);
    const questionOptions = question.options ?? [];
    if (questionOptions.length > 0) {
      lines.push('');
      questionOptions.forEach((option, at) => {
        const description = option.description;
        lines.push(`${at + 1}. ${description === undefined || description === '' ? option.label : `${option.label} — ${description}`}`);
      });
    }
    lines.push('');
  });

  lines.push(guidance(interaction));
  return lines.join('\n');
}
