/**
 * 版本常量。
 *
 * `PLUGIN_VERSION` 是 package.json 的权威副本：单测校验两者一致，漏改门禁直接红。
 * 发布时三处同步——package.json、锁文件（`npm version --no-git-tag-version`）、
 * 这里。
 */

export const PLUGIN_VERSION = '0.1.5';

/** 传输层实现版本：协议客户端行为变化时递增，与插件版本解耦。 */
export const CHANNEL_VERSION = '1';

/**
 * 面板两半的契约版本。
 *
 * 浏览器刷新就能拿到新的 `client.js`，host 半却要重装才更新；两边对不上时
 * 面板提示重启，而不是拿缺字段的响应硬渲染。
 */
export const PANEL_CONTRACT = 2;

/**
 * 面板 RPC 的通道名。
 *
 * 浏览器 `connection.rpc.call(channel, endpoint, payload)` 会 POST 到
 * `<channel>/<endpoint>`，所以 host 半挂 exact 路由 `/api/dsh-im-lark`，
 * 客户端用 channel `/api` + endpoint `dsh-im-lark`。
 */
export const RPC_CHANNEL = '/dsh-im-lark';

/** 客户端调用的 endpoint 段（`RPC_CHANNEL` 去掉前导斜杠）。 */
export const RPC_ENDPOINT = RPC_CHANNEL.replace(/^\/+/u, '');

/** 宿主 exact 路由的挂载前缀。 */
export const RPC_PREFIX = '/api';
