/**
 * 版本常量。
 *
 * `PLUGIN_VERSION` 是 package.json 的权威副本：单测校验两者一致，漏改门禁直接红。
 * 发布时三处同步——package.json、锁文件（`npm version --no-git-tag-version`）、
 * 这里。
 */

export const PLUGIN_VERSION = '0.1.0';

/** 传输层实现版本：协议客户端行为变化时递增，与插件版本解耦。 */
export const CHANNEL_VERSION = '1';
