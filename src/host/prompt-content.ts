/**
 * 把一条入站草稿变成会话输入：文字在前、图片在后，文件只给一句提示。
 *
 * 普通消息与 `/send` 共用：两处对「什么算一条输入」的口径必须一致。
 */

import type { OwnerMessageDraft } from './protocol.ts';
import type { PromptPart } from './standalone-types.ts';

export function buildContent(text: string, draft: OwnerMessageDraft): PromptPart[] {
  const parts: PromptPart[] = [];
  const body = text.trim();
  if (body === '' && (draft.images ?? []).length === 0) parts.push({ type: 'text', text: '（空消息）' });
  if (body !== '') parts.push({ type: 'text', text: body });
  for (const image of draft.images ?? []) {
    parts.push({ type: 'image', mediaType: image.mediaType, data: image.data, ...(image.name === undefined ? {} : { name: image.name }) });
  }
  const fileCount = draft.files?.length ?? 0;
  if (fileCount > 0) {
    parts.push({ type: 'text', text: `（收到 ${fileCount} 个文件；独立模式暂不转发文件内容）` });
  }
  return parts;
}
