import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LocalConfigStore,
  defaultSettings,
  normalizePluginConfig,
  normalizeSettings,
  settingsPath,
} from '../../src/host/config.ts';
import { DEFAULT_MAX_TEXT_CHARS } from '../../src/shared/limits.ts';
import { withTempDir } from './helpers/temp.ts';

test('配置：空对象拿到全部默认值，不抛错', () => {
  const config = normalizePluginConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.superagent, false);
  assert.equal(config.domain, 'feishu');
  assert.equal(config.maxText, DEFAULT_MAX_TEXT_CHARS);
  assert.equal(config.directBusyMode, 'steer');
  assert.equal(config.rpcPath, 'dsh-im-lark');
  assert.equal(config.directWorkspaceId, undefined);
  assert.equal(config.questionReminders, true);
  assert.equal(config.questionDelayMinutes, 5);
});

test('配置：非对象、null、字符串都当成空配置（否则插件装不上）', () => {
  for (const raw of [null, undefined, 'oops', 42, []]) {
    assert.doesNotThrow(() => normalizePluginConfig(raw));
  }
});

test('配置：数字越界或类型不对时回落默认，不做四舍五入到边界', () => {
  assert.equal(normalizePluginConfig({ maxText: 10 }).maxText, DEFAULT_MAX_TEXT_CHARS);
  assert.equal(normalizePluginConfig({ maxText: 99_999 }).maxText, DEFAULT_MAX_TEXT_CHARS);
  assert.equal(normalizePluginConfig({ maxText: '2000' }).maxText, DEFAULT_MAX_TEXT_CHARS);
  assert.equal(normalizePluginConfig({ maxText: 2500.4 }).maxText, 2500);
  assert.equal(normalizePluginConfig({ maxText: 4000 }).maxText, 4000);
});

test('配置：枚举字段只认白名单值', () => {
  assert.equal(normalizePluginConfig({ domain: 'lark' }).domain, 'lark');
  assert.equal(normalizePluginConfig({ domain: 'dingtalk' }).domain, 'feishu');
  assert.equal(normalizePluginConfig({ directBusyMode: 'queue' }).directBusyMode, 'queue');
  assert.equal(normalizePluginConfig({ directBusyMode: 'later' }).directBusyMode, 'steer');
  // 旧配置里的 interrupt 读进来就迁移成 steer，不留在磁盘上继续歧义。
  assert.equal(normalizePluginConfig({ directBusyMode: 'interrupt' }).directBusyMode, 'steer');
});

test('配置：提醒延迟只认 0–120 的整数分钟', () => {
  assert.equal(normalizePluginConfig({ questionDelayMinutes: 0 }).questionDelayMinutes, 0);
  assert.equal(normalizePluginConfig({ questionDelayMinutes: 120 }).questionDelayMinutes, 120);
  assert.equal(normalizePluginConfig({ questionDelayMinutes: 121 }).questionDelayMinutes, 5);
  assert.equal(normalizePluginConfig({ questionDelayMinutes: -1 }).questionDelayMinutes, 5);
  assert.equal(normalizePluginConfig({ questionDelayMinutes: '10' }).questionDelayMinutes, 5);
});

test('配置：空白字符串当作未设置（避免生成空目录名）', () => {
  assert.equal(normalizePluginConfig({ dataDir: '   ' }).dataDir, normalizePluginConfig({}).dataDir);
  assert.equal(normalizePluginConfig({ directWorkspaceId: '  ' }).directWorkspaceId, undefined);
  assert.equal(normalizePluginConfig({ rpcPath: '' }).rpcPath, 'dsh-im-lark');
});

test('设置：磁盘内容只覆盖合法字段，其余沿用默认', () => {
  const config = normalizePluginConfig({});
  const settings = normalizeSettings(
    { enabled: false, directBusyMode: 'queue', replyStatus: true },
    config,
  );
  assert.equal(settings.enabled, false);
  assert.equal(settings.directBusyMode, 'queue');
  assert.equal(settings.replyStatus, true);
  assert.equal(settings.typingIndicator, true);
});

test('设置：磁盘内容为 null 或非对象时整份用默认值', () => {
  const config = normalizePluginConfig({ superagent: true });
  for (const raw of [null, undefined, 'x', 7]) {
    assert.deepEqual(normalizeSettings(raw, config), defaultSettings(config));
  }
});

test('设置：保存后能读回，且是紧凑的 JSON 文件', async () => {
  await withTempDir(async (dir) => {
    const config = normalizePluginConfig({ dataDir: dir.path });
    const store = new LocalConfigStore({ dataDir: dir.path, config });

    const first = await store.load();
    assert.equal(first.enabled, true);

    await store.save({ enabled: false, directWorkspaceId: 'ws-1', replyStatus: true });
    assert.equal(store.current.enabled, false);
    assert.equal(store.current.directWorkspaceId, 'ws-1');

    // 新实例（等同重启）读同一份文件。
    const reopened = new LocalConfigStore({ dataDir: dir.path, config });
    const reloaded = await reopened.load();
    assert.equal(reloaded.enabled, false);
    assert.equal(reloaded.directWorkspaceId, 'ws-1');
    assert.equal(reloaded.replyStatus, true);
  });
});

test('设置：未 load 就读 current 会明确报错（避免读到半初始化状态）', () => {
  const store = new LocalConfigStore({ dataDir: '/tmp/never-used', config: normalizePluginConfig({}) });
  assert.throws(() => store.current, /先 await load/);
});

test('设置：文件损坏时不抛错，回落到默认值', async () => {
  await withTempDir(async (dir) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(settingsPath(dir.path), '{ 这不是 JSON', 'utf8');
    const config = normalizePluginConfig({ dataDir: dir.path });
    const store = new LocalConfigStore({ dataDir: dir.path, config });
    assert.equal((await store.load()).enabled, true);
  });
});
