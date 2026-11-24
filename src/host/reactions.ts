/**
 * 消息表情反馈的取值与打点约定。
 *
 * 取值来自官方[表情文案说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce)：
 * - `Get`（已收到/已受理语义）：收到消息就打，**永不撤销**——失败时它仍表示「收到过」；
 * - `DONE`：这一轮**真正结束**（回答送达）后追加在原消息上，与 `Get` 并排。
 *
 * `DONE` 不在「消息入队」时打：入队只代表消息被接收，任务之后才异步跑，入队就打会给
 * 「已完成」的假信号（核心模式下 GET 与 DONE 会几乎同时落地）。唯一的入站例外是提醒
 * 作答：它在认领时就同步结算了（多题只答一半时不算结算，不打）。
 */
import type { LarkApi } from './lark/api.ts';

export const REACTION_ACK = 'Get';
export const REACTION_DONE = 'DONE';

/**
 * 最佳努力加表情：表情可用性随租户配置变化，失败静默，绝不影响消息处理。
 * 返回是否成功，便于测试断言；调用方不据此做分支。
 */
export async function addReaction(api: LarkApi, messageId: string, emojiType: string): Promise<boolean> {
  try {
    await api.addReaction({ messageId, emojiType });
    return true;
  } catch {
    return false;
  }
}
