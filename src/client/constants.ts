/**
 * 面板常量。
 *
 * 通道名、槽位、契约版本必须与 host 半一致：浏览器刷新即可拿到新的
 * `client.js`，而 host 半要重装才更新，所以两边先对契约版本；对不上时面板
 * 提示重启，不拿缺字段的响应硬渲染。
 */

import { PANEL_CONTRACT, PLUGIN_VERSION, RPC_CHANNEL } from '../shared/version.ts';

export { PANEL_CONTRACT, PLUGIN_VERSION, RPC_CHANNEL };

export const PACKAGE_NAME = 'dsh-im-lark';

/** 插件页里按包名分发的配置槽位。 */
export const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config';

export const PANEL_NS = 'dsh-im-lark';

export const REFRESH_INTERVAL_MS = 15_000;

export const RPC_TIMEOUT_MS = 20_000;

export const ENDPOINTS = Object.freeze({
  status: 'status',
  saveCredentials: 'credentials.save',
  clearCredentials: 'credentials.clear',
  probe: 'probe',
  setSettings: 'settings.set',
  reconnect: 'reconnect',
} as const);
