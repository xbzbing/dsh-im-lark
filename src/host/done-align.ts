/**
 * 「哪条入站消息已经答完」的对齐队列：完成标记（`DONE`）不能按「最近一条」或
 * 「一条 turn/end 结算一条」来猜，两者都会把标记盖到没被回答的消息上。
 *
 * 依据宿主（DSH）的回合语义：
 * - `queue`（`followup`）：排队消息**独占自己的一轮**（core.md: `followup`
 *   "The item becomes the sole ordinary message of its own turn"）→ 一条 `turn/end`
 *   只结算队头那一条；
 * - `steer`（默认）：`steer` "An idle driver starts a turn; a running driver consumes
 *   it at its next step boundary" → 回合进行中提交的消息被**同一个回合吸收**，
 *   该回合只发一次 `turn/end`，因此队头之后的 steer 条目要在同一次结算里一起出队。
 *
 * 于是结算规则：取队头（开启这一轮的那条），再把其后连续的 steer 条目一并取走
 * ——它们已被本轮吸收；紧随其后的 queue 条目属于它自己之后的回合，留在队里。
 *
 * 前提：每个 `turn/end` 对应的这一轮**由队头那条开启**。queue 模式下若回合由 Web 端
 * 续聊或宿主自动续跑发起（没有对应的入站消息），队头会被提前结算——宿主事件里没有
 * 可对账的 prompt id（`turn/start` 只有 `{turn}`、`user/message` 无 id），只能靠这条
 * 前提；影响限于完成表情（可能早打或漏打），且只在非默认的 queue 模式下出现。
 */
export type SubmitMode = 'steer' | 'queue';

interface Pending {
  messageId: string;
  mode: SubmitMode;
}

export class DoneAlign {
  /** 已提交、尚无定论的消息，按提交顺序。 */
  readonly #pending: Pending[] = [];

  /** 提交成功（已入会话）后登记。 */
  push(messageId: string, mode: SubmitMode): void {
    this.#pending.push({ messageId, mode });
  }

  /**
   * 一轮结束：出队本轮应答的消息（平台消息 id）。
   * 交付失败时调用方仍要结算（这一轮已经消耗掉它们），只是不盖完成标记。
   */
  settle(): string[] {
    const head = this.#pending.shift();
    if (head === undefined) return [];
    const settled = [head.messageId];
    // 队头之后、连续提交的 steer 消息已被这一轮在步骤边界吸收。
    while (this.#pending[0]?.mode === 'steer') {
      const absorbed = this.#pending.shift();
      if (absorbed !== undefined) settled.push(absorbed.messageId);
    }
    return settled;
  }

  /**
   * 绑定会话换了（`/new`、`/sessions <序号>`）：旧会话的 `turn/end` 会被会话校验
   * 丢弃，残留条目永远等不到自己的回合，只会被下一轮错认。整队清掉。
   */
  clear(): void {
    this.#pending.length = 0;
  }
}
