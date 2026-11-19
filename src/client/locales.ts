/**
 * 面板文案。
 *
 * 中文是键的唯一来源（`LarkKey` 由它派生），英文按同一组键声明。宿主文案服务
 * 缺席时用 `fallbackTranslate` 兜底：面板宁可显示中文，也不能把 `panel.title`
 * 这样的键名露给用户。
 */

export const NS = 'dsh-im-lark';

export const zh = {
  'panel.title': '飞书机器人',
  'panel.subtitle': '在飞书里和这个工作区对话',
  'panel.loading': '正在读取状态…',
  'panel.refresh': '刷新',
  'panel.retry': '重试',

  'status.title': '连接状态',
  'status.connection': '长连接',
  'status.appId': 'App ID',
  'status.domain': '平台',
  'status.core': '超级助理',
  'status.coreOn': '已接入',
  'status.coreOff': '未安装或未启用',
  'status.enabled': '接入飞书',
  'status.enabledHint': '关闭后不再接收消息，已建立的连接会断开。',
  'status.superagent': '接入我的超级助理',
  'status.superagentHint': '打开后由核心接管会话；未安装核心时不可用。',
  'status.notConfigured': '未配置',
  'status.reconnect': '重新连接',
  'status.reconnecting': '正在重连…',

  'state.idle': '未连接',
  'state.connecting': '正在连接',
  'state.connected': '已连接',
  'state.reconnecting': '重连中',
  'state.failed': '连接失败',

  'credentials.title': '应用凭据',
  'credentials.hint': '在飞书开放平台「凭证与基础信息」里获取。只保存在本机，面板不会回显 Secret。',
  'credentials.appId': 'App ID',
  'credentials.appSecret': 'App Secret',
  'credentials.appSecretPlaceholder': '已设置，留空则不修改',
  'credentials.domain': '平台',
  'credentials.domainFeishu': '飞书（中国）',
  'credentials.domainLark': 'Lark（国际）',
  'credentials.save': '保存并连接',
  'credentials.saving': '正在保存…',
  'credentials.probe': '连接自检',
  'credentials.probing': '正在自检…',
  'credentials.clear': '清除凭据',
  'credentials.cleared': '凭据已清除',
  'credentials.saved': '已保存，正在建立连接',
  'credentials.probeOk': '自检通过：{name}',
  'credentials.probeOkNoName': '自检通过',
  'credentials.appIdRequired': '请填写 App ID',
  'credentials.appSecretRequired': '首次配置需要填写 App Secret',

  'behavior.title': '消息行为',
  'behavior.typing': '「正在处理」表情',
  'behavior.typingHint': '收到消息时加一个表情，处理完移除。飞书没有官方输入状态接口。',
  'behavior.replyStatus': '回复末尾显示状态',
  'behavior.replyStatusHint': '附加模型、推理等级与耗时；仅独立会话生效。',
  'behavior.reminders': '问题与审批提醒',
  'behavior.remindersHint': '会话停下来等人时，在飞书里提醒一句。',
  'behavior.delay': '提醒前等待（分钟）',
  'behavior.longTask': '长任务提醒阈值（分钟）',
  'behavior.save': '保存设置',
  'behavior.saving': '正在保存…',

  'error.connection': '连不上 Host：刷新页面再试。',
  'error.contract': '面板与插件版本不一致，请重启 dsh web。',
  'error.generic': '操作失败',
} as const;

export type LarkKey = keyof typeof zh;

export const en: Record<LarkKey, string> = {
  'panel.title': 'Feishu bot',
  'panel.subtitle': 'Talk to this workspace from Feishu',
  'panel.loading': 'Loading status…',
  'panel.refresh': 'Refresh',
  'panel.retry': 'Retry',

  'status.title': 'Connection',
  'status.connection': 'Long connection',
  'status.appId': 'App ID',
  'status.domain': 'Platform',
  'status.core': 'Super agent',
  'status.coreOn': 'Connected',
  'status.coreOff': 'Not installed or disabled',
  'status.enabled': 'Connect Feishu',
  'status.enabledHint': 'When off, no messages are received and the connection closes.',
  'status.superagent': 'Use my super agent',
  'status.superagentHint': 'The core owns the session. Unavailable without the core.',
  'status.notConfigured': 'Not configured',
  'status.reconnect': 'Reconnect',
  'status.reconnecting': 'Reconnecting…',

  'state.idle': 'Disconnected',
  'state.connecting': 'Connecting',
  'state.connected': 'Connected',
  'state.reconnecting': 'Reconnecting',
  'state.failed': 'Failed',

  'credentials.title': 'App credentials',
  'credentials.hint': 'From the Feishu developer console. Stored locally; the secret is never echoed.',
  'credentials.appId': 'App ID',
  'credentials.appSecret': 'App Secret',
  'credentials.appSecretPlaceholder': 'Already set; leave blank to keep',
  'credentials.domain': 'Platform',
  'credentials.domainFeishu': 'Feishu (China)',
  'credentials.domainLark': 'Lark (international)',
  'credentials.save': 'Save and connect',
  'credentials.saving': 'Saving…',
  'credentials.probe': 'Test connection',
  'credentials.probing': 'Testing…',
  'credentials.clear': 'Clear credentials',
  'credentials.cleared': 'Credentials cleared',
  'credentials.saved': 'Saved; connecting',
  'credentials.probeOk': 'OK: {name}',
  'credentials.probeOkNoName': 'OK',
  'credentials.appIdRequired': 'App ID is required',
  'credentials.appSecretRequired': 'App Secret is required for the first setup',

  'behavior.title': 'Message behavior',
  'behavior.typing': '“Working” reaction',
  'behavior.typingHint': 'Adds a reaction while handling. Feishu has no official typing API.',
  'behavior.replyStatus': 'Status line in replies',
  'behavior.replyStatusHint': 'Model, reasoning effort and duration; standalone sessions only.',
  'behavior.reminders': 'Question and approval reminders',
  'behavior.remindersHint': 'Ping you in Feishu when a session is waiting for a human.',
  'behavior.delay': 'Reminder delay (minutes)',
  'behavior.longTask': 'Long task threshold (minutes)',
  'behavior.save': 'Save settings',
  'behavior.saving': 'Saving…',

  'error.connection': 'Cannot reach the host. Refresh the page and retry.',
  'error.contract': 'Panel and plugin versions differ. Restart dsh web.',
  'error.generic': 'Operation failed',
};

export type TranslateParams = Record<string, string | number>;

export type Translate = (key: LarkKey, params?: TranslateParams) => string;

/** 没有 `ctx.locale` 时的翻译：查中文，插值规则与宿主一致。 */
export function fallbackTranslate(key: LarkKey, params?: TranslateParams): string {
  const template = zh[key] as string;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
