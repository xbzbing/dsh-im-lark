/**
 * 桥的文本与错误辅助：卡片装不下时的降级文本、协议回执的错误截断与错误码。
 *
 * 独立成模块，让 `bridge.ts` 只留协议语义；这些函数不持有状态。
 */

import type { Delivery, Receipt } from './protocol.ts';
import { interactionText } from './question-text.ts';

/**
 * 卡片装不下时退回的文本内容（由 outbound 渲染成 markdown 卡片）。
 *
 * 交互必须一起带上——降级后用户只能文字作答，不给题目和选项就没法答；
 * 标题由 outbound 的卡片头渲染，正文不再重复 `#`。
 */
export function renderFallbackText(delivery: Delivery): string {
  const interaction = delivery.interaction === undefined
    ? ''
    : interactionText(delivery.interaction, { markdown: false });
  return [delivery.body, delivery.detail ?? '', interaction]
    .filter((part) => part !== '')
    .join('\n\n');
}

/** 协议规定 `Receipt.error` 最多 500 字符；超长会让核心解析失败并按 uncertain 重投。 */
function truncateError(error: string): string {
  return error.length > 500 ? `${error.slice(0, 497)}...` : error;
}

export function failure(deliveryId: string, errorCode: NonNullable<Receipt['errorCode']>, error: string): Receipt {
  return { deliveryId, status: 'failed', messagesSent: 0, errorCode, error: truncateError(error) };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
