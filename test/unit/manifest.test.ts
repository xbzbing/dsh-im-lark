import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { PLUGIN_VERSION } from '../../src/shared/version.ts';

const root = new URL('../../', import.meta.url);

async function manifest(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as Record<string, any>;
}

test('清单：版本与源码常量一致（发布时三处同步）', async () => {
  const pkg = await manifest();
  assert.equal(pkg.version, PLUGIN_VERSION);
});

test('清单：入口指向构建产物，两半都声明了', async () => {
  const pkg = await manifest();
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './lib/index.js');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0);
});

test('清单：运行时依赖只有官方 SDK 且钉死版本', async () => {
  const pkg = await manifest();
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@larksuiteoapi/node-sdk']);
  const version = pkg.dependencies['@larksuiteoapi/node-sdk'];
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('清单：核心包只在 devDependencies（一致性测试用）', async () => {
  const pkg = await manifest();
  assert.equal(pkg.dependencies['dsh-my-superagent'], undefined);
  assert.equal(typeof pkg.devDependencies?.['dsh-my-superagent'], 'string');
});

test('清单：peer 依赖只允许 @deepseek-ai/* 且可选', async () => {
  const pkg = await manifest();
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    assert.match(name, /^@deepseek-ai\//);
    assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true);
    assert.equal(typeof range, 'string');
  }
});

test('补丁文件：只插入本插件，不删也不替换别人的条目', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
  assert.match(patch, /id: dsh-im-lark/);
  assert.equal(/^\s*remove:/m.test(patch), false);
  assert.equal(/^\s*replace:/m.test(patch), false);
});
