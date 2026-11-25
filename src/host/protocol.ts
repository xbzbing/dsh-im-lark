/**
 * `my-superagent/v1` 的最小结构类型。
 *
 * **刻意不 import `dsh-my-superagent`**：宿主插件与核心服务通过这个结构契约
 * 协作，而不是共享编译产物。核心升级时，形状没变就不用跟着发版；形状变了，
 * 我们的类型检查会在边界上发现，而不是运行时才发现字段是 `undefined`。
 *
 * 字段含义以核心仓库的 `src/protocol/messages.ts` 为准（同一份协议的另一端）。
 */

export const PROTOCOL_V1 = 'my-superagent/v1';

export type DeliveryIntent = 'action' | 'confirm' | 'result' | 'progress' | 'digest';

export interface InteractionOption {
  label: string;
  description?: string;
}

export interface InteractionQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: readonly InteractionOption[];
  multiSelect?: boolean;
  intent?: 'plan-review' | 'approval';
}

export interface InteractionAnswerItem {
  id: string;
  selected: readonly string[];
  custom?: string;
}

export interface Interaction {
  questions: readonly InteractionQuestion[];
  suggested?: readonly InteractionAnswerItem[];
  rationale?: string;
}

export interface InteractionAnswerDraft {
  deliveryId: string;
  sender: string;
  answers: readonly InteractionAnswerItem[];
  at: number;
}

export interface DeliveryRef {
  kind: 'session' | 'signal' | 'task' | 'decision';
  id: string;
  title?: string;
}

export interface DeliveryStream {
  id: string;
  revision: number;
  final: boolean;
}

export interface DeliveryImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
  name?: string;
}

export interface Delivery {
  protocol: string;
  id: string;
  recipient: string;
  intent: DeliveryIntent;
  title: string;
  body: string;
  detail?: string;
  interaction?: Interaction;
  refs?: readonly DeliveryRef[];
  expiresAt?: number;
  supersedes?: string;
  stream?: DeliveryStream;
  inReplyTo?: string;
  /**
   * 这次交付完成了哪些用户消息（`OwnerMessageDraft.messageId`，最多 20 条）。
   * 只有正常收尾的回合才会带：停滞提醒、重启孤儿、派发回执、转投确认、命令回复都不带。
   * 旧核心不发这个字段——漏打完成标记优于误打。
   */
  completes?: readonly string[];
  images?: readonly DeliveryImage[];
}

export interface Receipt {
  deliveryId: string;
  status: 'sent' | 'failed' | 'uncertain';
  bridgeMessageId?: string;
  bridgeMessageIds?: readonly string[];
  messagesSent?: number;
  error?: string;
  errorCode?: 'window-closed' | 'rate-limited' | 'auth-expired' | 'too-long' | 'other';
}

export interface BridgeCapabilities {
  markdown: 'none' | 'basic' | 'full';
  maxText: { max: number; unit: 'char' | 'utf8-byte' };
  interaction?: {
    choice: boolean;
    multiChoice: boolean;
    freeText: boolean;
    maxOptions: number;
    maxQuestions: number;
    updateAfterAnswer: 'any' | 'immediate' | 'none';
  };
  edit?: { scope: 'any' | 'reply'; minIntervalMs: number; maxLifetimeMs?: number };
  detail: boolean;
  nativeCommands: boolean;
  quoteReply?: boolean;
  quotas?: readonly { scope: 'bot' | 'conversation'; max: number; windowMs: number }[];
  outbound: {
    requiresPriorInbound: boolean;
    windowMs?: number;
    maxMessagesPerWindow?: number;
    images?: boolean;
  };
}

export interface BridgeHealth {
  state: 'ok' | 'degraded' | 'down';
  code?: 'auth-expired' | 'kicked' | 'rate-limited' | 'network' | 'other';
  reason?: string;
}

export type RejectReason =
  | 'invalid'
  | 'not-owner'
  | 'unknown'
  | 'settled'
  | 'expired'
  | 'wrong-bridge'
  | 'not-delivered'
  | 'not-allowed'
  | 'invalid-answer';

export type AcceptResult = { accepted: true } | { accepted: false; reason: RejectReason; detail?: string };

export interface OwnerImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
  name?: string;
}

export interface OwnerFile {
  name: string;
  mediaType?: string;
  data: string;
}

export interface OwnerMessageDraft {
  /** 渠道内唯一的去重键。 */
  messageId: string;
  sender: string;
  /** 消息所在会话。**桥内部使用**：协议 v1 没有这个字段，核心解析时会忽略。 */
  chatId?: string;
  text: string;
  at: number;
  replyTo?: string;
  /** 平台消息 id；核心用它做引用目录的键。 */
  platformMessageId?: string;
  images?: readonly OwnerImage[];
  files?: readonly OwnerFile[];
}

export interface CommandInfo {
  name: string;
  usage: string;
  description: string;
}

export interface BridgeHandle {
  readonly id: string;
  readonly protocol: string;
  receive(message: OwnerMessageDraft): Promise<AcceptResult>;
  answer(answer: InteractionAnswerDraft): Promise<AcceptResult>;
  update(capabilities: BridgeCapabilities): void;
  commands(): readonly CommandInfo[];
  isOwner(sender: string): boolean;
  dispose(): void;
}

export interface BridgeProvider {
  platform: string;
  account: string;
  protocol: readonly string[];
  capabilities: BridgeCapabilities;
  deliver(delivery: Delivery): Promise<Receipt>;
  health(): BridgeHealth;
}

export interface Registry<P, H> {
  register(provider: P): H;
}

/** 宿主注入的核心服务：只声明我们用到的两个入口。 */
export interface MySuperagentService {
  readonly protocol: { versions: readonly string[]; features?: readonly string[] };
  readonly bridges: Registry<BridgeProvider, BridgeHandle>;
}
