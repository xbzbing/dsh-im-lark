/**
 * 提问与授权的文字化：宿主给的结构化请求 → 飞书里能读的一段话，以及主人回的那句话
 * → 宿主能收下的结构化答案。
 *
 * 匹配规则必须与宿主/核心一致，否则主人在 Web 端能答、在飞书里答不对：
 * - 单题认序号、选项文字、整段自由输入（自由输入落成 `custom`）；
 * - 多题按「；」「。」或换行分段，段数对上就一段一题，整段自由输入不算作答；
 * - 计划审阅认批准词与继续规划，其余文字都算修改意见。
 *
 * 这里只做转换，不发消息、不持有状态。
 */

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: AskOption[];
  multiSelect?: boolean;
  intent?: { kind: string; approve?: string; reject?: string };
}

export interface AnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface Answer {
  answers: AnswerItem[];
}

/** 授权请求里本模块用到的字段（结构类型，不 import 宿主包）。 */
export interface ApprovalRequest {
  agent?: unknown;
  toolName?: unknown;
  callId?: unknown;
  reason?: unknown;
  signal?: AbortSignal;
}

/** 飞书能给出的两个决定；其余结局都由宿主或 Web 端收尾。 */
export type ApprovalDecision = 'allowed-once' | 'rejected';

const DEFAULT_APPROVE = /^(1|批准|通过|同意|可以|approve|yes|y|ok)$/iu;
const DEFAULT_KEEP = /^(2|继续规划|keep planning)$/iu;
const SEGMENT_SPLIT = /[；;。\n]+/u;
const REASON_MAX = 200;

/** 明确的批准/拒绝词，可带提醒编号（`批准 3`、`拒绝#2`）。 */
const APPROVE = /^(批准|同意|approve|yes)(?:\s*[#第]?\s*(\d+)\s*[条号]?)?$/iu;
const REJECT = /^(拒绝|不批准|不同意|deny|reject|no)(?:\s*[#第]?\s*(\d+)\s*[条号]?)?$/iu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 把宿主给的题目收窄成确定形状；认不出的题直接丢掉。 */
export function normalizeQuestions(value: unknown): AskQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: AskQuestion[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const id = textOf(record.id);
    const question = textOf(record.question);
    if (id === '' || question === '') continue;

    const options: AskOption[] = [];
    if (Array.isArray(record.options)) {
      for (const raw of record.options) {
        const option = asRecord(raw);
        const label = textOf(option?.label);
        if (option === null || label === '') continue;
        const description = textOf(option.description);
        options.push(description === '' ? { label } : { label, description });
      }
    }

    const intent = asRecord(record.intent);
    const kind = textOf(intent?.kind);
    questions.push({
      id,
      question,
      ...(textOf(record.detail) === '' ? {} : { detail: textOf(record.detail) }),
      ...(textOf(record.header) === '' ? {} : { header: textOf(record.header) }),
      ...(options.length === 0 ? {} : { options }),
      ...(record.multiSelect === true ? { multiSelect: true } : {}),
      ...(kind === ''
        ? {}
        : {
          intent: {
            kind,
            ...(textOf(intent?.approve) === '' ? {} : { approve: textOf(intent?.approve) }),
            ...(textOf(intent?.reject) === '' ? {} : { reject: textOf(intent?.reject) }),
          },
        }),
    });
  }
  return questions;
}

function planReviewQuestion(questions: readonly AskQuestion[]): AskQuestion | null {
  if (questions.length !== 1) return null;
  const question = questions[0]!;
  return question.intent?.kind === 'plan-review' ? question : null;
}

/** 计划审阅：批准项由题目自己指定，其余选项都算「不批准」。 */
function answerPlanReview(question: AskQuestion, reply: string): Answer {
  const options = question.options ?? [];
  const approve = question.intent?.approve ?? options[0]?.label ?? '批准';
  const keep = options.find((option) => option.label !== approve)?.label ?? '继续规划';
  if (reply.toLowerCase() === approve.toLowerCase() || DEFAULT_APPROVE.test(reply)) {
    return { answers: [{ id: question.id, selected: [approve] }] };
  }
  if (reply.toLowerCase() === keep.toLowerCase() || DEFAULT_KEEP.test(reply)) {
    return { answers: [{ id: question.id, selected: [keep] }] };
  }
  return { answers: [{ id: question.id, selected: [keep], custom: reply }] };
}

/** 单题：精确选项 → 序号/文字组合 → 自由输入。 */
function answerOne(question: AskQuestion, reply: string): AnswerItem {
  const options = question.options ?? [];
  const exact = options.find((option) => option.label.toLowerCase() === reply.toLowerCase());
  if (exact !== undefined) return { id: question.id, selected: [exact.label] };

  const tokens = reply.split(/[\s,，、]+/u).filter(Boolean);
  const labels = tokens.map((token) => {
    if (/^\d+$/u.test(token)) return options[Number(token) - 1]?.label;
    return options.find((option) => option.label.toLowerCase() === token.toLowerCase())?.label;
  });
  const resolved = labels.length > 0 && labels.every((label) => label !== undefined);
  if (options.length > 0 && resolved && (question.multiSelect === true || labels.length === 1)) {
    return { id: question.id, selected: [...new Set(labels as string[])] };
  }
  return { id: question.id, selected: [], custom: reply };
}

/** 主人的一句话 → 结构化答案；返回 null 表示不是作答。 */
export function answerFromText(questions: readonly AskQuestion[], input: string): Answer | null {
  const reply = input.trim();
  if (reply === '' || questions.length === 0) return null;

  const plan = planReviewQuestion(questions);
  if (plan !== null) return answerPlanReview(plan, reply);

  if (questions.length > 1) {
    const segments = reply.split(SEGMENT_SPLIT).map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === questions.length) {
      return { answers: questions.map((question, index) => answerOne(question, segments[index]!)) };
    }
    return { answers: questions.map((question) => ({ id: question.id, selected: [], custom: reply })) };
  }

  return { answers: [answerOne(questions[0]!, reply)] };
}

/**
 * 这句话是否「像」一个答案——只决定要不要认领，解析仍交给 `answerFromText`。
 *
 * 单题（含计划审阅）认任意非空文本：提醒里写着可以直接回复文字。多题只认分段都
 * 落到选项/序号上的作答，整段自由输入交给普通消息路径，避免把聊天吞成答案。
 */
export function looksLikeAnswer(questions: readonly AskQuestion[], text: string): boolean {
  const reply = text.trim();
  if (reply === '' || questions.length === 0) return false;
  if (questions.length === 1) return true;

  const segments = reply.split(SEGMENT_SPLIT).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length !== questions.length) return false;
  return segments.every((segment, index) => resolvesToOption(questions[index]!, segment));
}

function resolvesToOption(question: AskQuestion, reply: string): boolean {
  const options = question.options ?? [];
  if (options.length === 0) return false;
  if (options.some((option) => option.label.toLowerCase() === reply.toLowerCase())) return true;
  const tokens = reply.split(/[\s,，、]+/u).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => {
    if (/^\d+$/u.test(token)) {
      const index = Number(token) - 1;
      return index >= 0 && index < options.length;
    }
    return options.some((option) => option.label.toLowerCase() === token.toLowerCase());
  });
}

/** 题目 → 飞书里的一段纯文本（文本消息不渲染 Markdown，不用标记符号）。 */
export function renderQuestions(questions: readonly AskQuestion[], no: number): string {
  const lines = [`需要你回答（#${no}）`, ''];
  questions.forEach((question, index) => {
    if (index > 0) lines.push('');
    const header = question.header ?? (questions.length > 1 ? `第 ${index + 1} 题` : '');
    if (header !== '') lines.push(header);
    lines.push(question.question);
    if (question.detail !== undefined) lines.push(question.detail);
    const options = question.options ?? [];
    options.forEach((option, position) => {
      lines.push(`${position + 1}. ${option.label}${option.description === undefined ? '' : ` —— ${option.description}`}`);
    });
    if (question.intent?.kind === 'plan-review') {
      const approve = question.intent.approve ?? options[0]?.label ?? '批准';
      lines.push(`回复「${approve}」批准，或回复修改意见继续规划。`);
    } else if (options.length > 0) {
      lines.push(question.multiSelect === true
        ? '回复序号或选项文字，多个用逗号分隔。'
        : '回复序号或选项文字；也可以直接输入你的答案。');
    } else {
      lines.push('直接回复你的答案。');
    }
  });
  if (questions.length > 1) lines.push('', '多题请用「；」或换行分开，一段一题。');
  lines.push('', '在 Web 端回答后，这条提醒会自动作废。');
  return lines.join('\n');
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function toolNameOf(request: ApprovalRequest): string {
  return typeof request.toolName === 'string' && request.toolName.trim() !== ''
    ? request.toolName.trim()
    : '某个工具';
}

function reasonOf(request: ApprovalRequest): string {
  if (typeof request.reason !== 'string') return '';
  const text = oneLine(request.reason);
  if (text === '') return '';
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}

/** 授权提醒：带编号，原因单行截断；说明怎么指定多条中的某一条。 */
export function renderApproval(request: ApprovalRequest, no: number): string {
  const lines = [`需要你授权 #${no}：${toolNameOf(request)}`];
  const reason = reasonOf(request);
  if (reason !== '') lines.push(reason);
  lines.push('回复「批准」或「拒绝」；多个在等时加编号（如「批准 3」）。不回复就到 Web 端处理。');
  return lines.join('\n');
}

export interface Decision {
  outcome: ApprovalDecision;
  /** 指定的提醒编号；没带编号时由调用方认最后一条。 */
  no?: number;
}

/**
 * 去掉首尾引号（主人常把文案里的「批准」连引号一起抄回来）与句末标点。
 *
 * 引号和标点一起从两端剥，而不是分两轮按顺序剥：`「批准」。` 这种「引号里带
 * 句号、句号在引号外」的抄法，分轮处理会剩下半个引号。
 */
function trimmed(text: string): string {
  return text.trim()
    .replace(/^[「『“"'。.!！?？\s]+/u, '')
    .replace(/[」』”"'。.!！?？\s]+$/u, '')
    .trim();
}

/** 解析一条入站文本；不是明确决定时返回 null（交给普通消息路径）。 */
export function parseDecision(text: string): Decision | null {
  const value = trimmed(text);
  if (value === '') return null;
  const approve = APPROVE.exec(value);
  if (approve !== null) return decisionOf('allowed-once', approve[2]);
  const reject = REJECT.exec(value);
  if (reject !== null) return decisionOf('rejected', reject[2]);
  return null;
}

/** 带了编号就必须是有效编号：`批准 0` 这类输入一律不认（失败关闭）。 */
function decisionOf(outcome: ApprovalDecision, raw: string | undefined): Decision | null {
  if (raw === undefined) return { outcome };
  const no = Number(raw);
  return Number.isSafeInteger(no) && no > 0 ? { outcome, no } : null;
}
