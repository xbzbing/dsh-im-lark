/**
 * 飞书侧用到的领域类型。
 *
 * 这些形状**不来自 SDK**：SDK 只是传输实现，领域层按自己的需要描述。好处是测试
 * 可以注入假实现，SDK 升级也不会把它的类型渗透到业务代码里。
 *
 * 字段含义以 `docs/protocol/00-飞书开放平台事实.md` 为准。
 */

/** 飞书域名：国内 feishu、国际 lark。 */
export type LarkDomain = 'feishu' | 'lark';

export interface LarkCredentials {
  appId: string;
  appSecret: string;
  domain: LarkDomain;
}

/** 连接凭据里可以安全展示的部分：secret 永远不出这个边界。 */
export interface LarkCredentialSummary {
  appId: string;
  /** App ID 尾号，面板只显示它。 */
  appIdTail: string;
  domain: LarkDomain;
}

export type LarkChatType = 'p2p' | 'group';

export interface LarkMention {
  /** 正文里的占位符，形如 `@_user_1`。 */
  key: string;
  name?: string;
  openId?: string;
  userId?: string;
  isBot?: boolean;
}

/** 一条入站消息（已从事件包装里解出来的部分）。 */
export interface LarkInboundMessage {
  /** 平台消息 id，引用回指时原样带回。 */
  messageId: string;
  chatId: string;
  chatType: LarkChatType;
  /** `text` / `post` / `image` / `file` / `audio` / `media` / `sticker` / `interactive` / `system` … */
  messageType: string;
  /** 平台给的原始 JSON 字符串，解析在 `content.ts` 做。 */
  content: string;
  /** 毫秒时间戳。 */
  createTime: number;
  /** 回复了哪条消息（话题外）；引用回指用它。 */
  parentId?: string;
  rootId?: string;
  threadId?: string;
  senderOpenId: string;
  /** `user` 或 `bot`：机器人自己发的消息要跳过，避免自激。 */
  senderType: 'user' | 'bot';
  mentions: readonly LarkMention[];
}

/** 卡片回传交互（按钮点击）。 */
export interface LarkCardAction {
  /** 回调事件 id，仅用于日志与去重。 */
  eventId: string;
  /** 卡片所在消息 id。 */
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  /** 按钮上配置的 `value` 对象（飞书要求回传参数是对象）。 */
  value: Record<string, unknown>;
  /** 表单容器提交的数据；本期不用，但类型上留着。 */
  formValues?: Record<string, unknown>;
}

/** 出站消息的公共参数。 */
export interface LarkSendOptions {
  /** 幂等键：相同 uuid 1 小时内至多成功一条。 */
  uuid?: string;
  /** 回复某条消息（走 reply 接口）。 */
  replyTo?: string;
}

export interface LarkSendResult {
  messageId: string;
  /** 消息所在会话 id（发送接口会回填）。 */
  chatId?: string;
}

/** 上传后拿到的资源 key。 */
export interface LarkUploadedImage {
  imageKey: string;
}

export interface LarkUploadedFile {
  fileKey: string;
}

/** 下载消息资源的结果。 */
export interface LarkResource {
  bytes: Uint8Array;
  contentType?: string;
}

/** `token` 自检结果：面板据此显示「凭据可用」。 */
export interface LarkCredentialCheck {
  ok: boolean;
  /** 机器人自己的 open_id（若接口返回）。 */
  botOpenId?: string;
  botName?: string;
  error?: string;
}
