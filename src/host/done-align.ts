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
 * 排队消息在提交时目标可能已经在跑别人的一轮（Web 端发起、宿主自动续跑、或就是前
 * 一条消息那一轮）。这一轮的 `turn/end` 不是它开启的，标成 `waiting` 跳过这一次结算；
 * 等它自己那一轮开始（届时队列换到它）再结算，避免「入队就算完成」。
 *
 * 前提：每个 `turn/end` 对应的这一轮**由队头那条开启**，或队头在 `waiting` 里明确
 * 排在这一轮之后。宿主事件里没有可对账的 prompt id（`turn/start` 只有 `{turn}`、
 * `user/message` 无 id），所以 steer 在「列表说空闲、提交时已在跑」这类快照抖动下
 * 仍可能错位；影响限于完成表情（可能早打或漏打），且只在非默认的 queue 模式出现。
 */
export type SubmitMode = 'steer' | 'queue';

interface Pending {
  messageId: string;
  mode: SubmitMode;
  /** 提交时目标正在跑别人的一轮、这条又是排队：下一个 `turn/end` 不属于它。 */
  waiting: boolean;
}

export class DoneAlign {
  /** 已提交、尚无定论的消息，按提交顺序。 */
  readonly #pending: Pending[] = [];

  /** 提交成功（已入会话）后登记。`waiting` 表示它排在别人正跑的那一轮之后。 */
  push(messageId: string, mode: SubmitMode, waiting = false): void {
    this.#pending.push({ messageId, mode, waiting: waiting && mode === 'queue' });
  }

  /**
   * 一轮结束：出队本轮应答的消息（平台消息 id）。
   * 交付失败时调用方仍要结算（这一轮已经消耗掉它们），只是不盖完成标记。
   */
  settle(): string[] {
    const head = this.#pending[0];
    if (head === undefined) return [];

    if (head.waiting) {
      // 这一轮是队头排的那一轮，不是它自己：它现在才轮到，只结算被本轮吸收的 steer。
      head.waiting = false;
      return this.#takeAbsorbed(1);
    }

    this.#pending.shift();
    const settled = [head.messageId, ...this.#takeAbsorbed()];
    // 队头这一轮结束后，紧随的排队消息自己的一轮随即开始，不再等别人的 `turn/end`。
    const next = this.#pending[0];
    if (next?.mode === 'queue') next.waiting = false;
    return settled;
  }

  /**
   * 绑定会话换了（`/new`、`/switch`）：旧会话的 `turn/end` 会被会话校验
   * 丢弃，残留条目永远等不到自己的回合，只会被下一轮错认。整队清掉。
   */
  clear(): void {
    this.#pending.length = 0;
  }

  /**
   * 取走 `start` 起连续提交的 steer 条目：它们已被刚结束的这一轮在步骤边界吸收。
   * 默认从队头扫；`waiting` 分支队头要留下，就从它的下一条开始。
   */
  #takeAbsorbed(start = 0): string[] {
    const settled: string[] = [];
    while (this.#pending[start]?.mode === 'steer') {
      const absorbed = this.#pending.splice(start, 1)[0];
      if (absorbed !== undefined) settled.push(absorbed.messageId);
    }
    return settled;
  }
}
