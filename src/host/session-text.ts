/**
 * 宿主 `session/event` 的取字段小工具。
 *
 * 独立会话与 `/send` 观察者都要从事件里取 assistant 文本，放在这里避免两边各写一份；
 * 只做形状收窄，不认识的结构一律按「没有」处理。
 */

export function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/** 从 `assistant/message` 的 content 块里取文字。 */
export function textFromAssistantMessage(message: unknown): string {
  const content = asRecord(message)?.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    const item = asRecord(block);
    if (item !== null && item.type === 'text' && typeof item.text === 'string') text += item.text;
  }
  return text;
}
