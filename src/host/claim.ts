/**
 * 「这段文本是不是提醒的作答」的认领结果（三态）。
 *
 * - `settled`：作答完整并已结算（提醒兑现、卡片刷成终态）——这条消息处理完了；
 * - `unsettled`：认下了，但还在等后续作答。多题只答一半时提醒会回一句格式提示并
 *   继续挂起（`questions.ts` 的 `#noteGuidance`），**不能盖完成标记**——否则就是
 *   「还没答完却显示已完成」，正是完成标记要避免的假信号；
 * - `undefined`：不是作答，走普通消息路径。
 */
export type ClaimOutcome = 'settled' | 'unsettled';
