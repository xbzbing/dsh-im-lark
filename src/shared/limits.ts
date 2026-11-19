/**
 * 跨上下文共用的数值上限。
 *
 * 平台侧的硬限制来自飞书开放平台文档（见 `docs/protocol/00-飞书开放平台事实.md`），
 * 这里只写插件自己用的常量，并注明它对应哪一条平台限制——改的时候能一眼看出
 * 是不是在跟平台契约抬杠。
 */

/** 卡片请求体上限 30 KB；按 UTF-8 字节计，留出 JSON 转义与组件开销。 */
export const CARD_BODY_BYTES_MAX = 28 * 1024;

/** 文本消息请求体上限 150 KB；我们远达不到，仍按它兜一道。 */
export const TEXT_BODY_BYTES_MAX = 140 * 1024;

/**
 * 单条交付的默认字符上限。
 *
 * 取 2000 字符（中文约 6 KB）而不是贴着 30 KB：卡片里还有标题、按钮、折叠面板，
 * 且 `content` 是 JSON 字符串序列化后的结果（引号与换行都要转义），实测体积比正
 * 文大一截。宁可多分一条，也不要在真机上撞 230025。
 */
export const DEFAULT_MAX_TEXT_CHARS = 2_000;

/** 单次交付最多分多少条：超长正文按段切，但不做无上限放大。 */
export const MAX_SEGMENTS = 30;

/** 入站文件：单条最多几个（与核心协议一致）。 */
export const OWNER_FILES_MAX = 3;

/** 入站图片：单条最多几张（与核心协议一致）。 */
export const OWNER_IMAGES_MAX = 9;

/** 出站图片：单条最多几张（与核心协议一致）。 */
export const DELIVERY_IMAGES_MAX = 4;

/** 下载入站资源的单次超时（毫秒）：事件处理是异步的，但不能无限挂。 */
export const DOWNLOAD_TIMEOUT_MS = 30_000;

/** 单张入站图片的字节上限：飞书上传图片本身限 10 MB。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 单个入站文件的字节上限（核心协议 8 MiB）；更大的文件只报文件名。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 一条消息内全部文件的合计字节上限（核心协议 16 MiB）。 */
export const MAX_FILES_BYTES = 16 * 1024 * 1024;

/** 出站文件上传上限：飞书 `/im/v1/files` 限 30 MB。 */
export const MAX_UPLOAD_FILE_BYTES = 30 * 1024 * 1024;

/** 出站图片上传上限：飞书 `/im/v1/images` 限 10 MB。 */
export const MAX_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

/** 卡片原地更新的最短间隔：平台限单卡 5 QPS，取 2 秒留余量。 */
export const CARD_EDIT_MIN_INTERVAL_MS = 2_000;

/** 卡片可更新的时限：平台硬限制 14 天。 */
export const CARD_EDIT_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/** 同用户/同群发送的业务级限频：5 QPS。 */
export const SEND_QPS = 5;

/** 发送令牌桶的窗口。 */
export const SEND_WINDOW_MS = 1_000;

/** 长任务提醒的默认阈值（分钟）。 */
export const DEFAULT_LONG_TASK_MINUTES = 30;

/** 问题提醒的默认等待时间（分钟）：这段时间里在 Web 端答完就不打扰。 */
export const DEFAULT_QUESTION_DELAY_MINUTES = 5;
