#!/usr/bin/env node
/**
 * 打包自洽性校验（`npm run check` 的一部分）。
 *
 * `lib/` 是 `npm run build` 的产物，装的是它、跑的是它，所以「源码改了但忘了
 * build」是最常见的翻车方式，症状却在运行期（插件不激活、面板白屏）。这里替代
 * 打包器的自检职责：
 *
 * 1. `lib/` 能否由当前源码确定性重建（重建成临时目录后逐字节比对）；
 * 2. 产物在不在、清单指不指得到；
 * 3. 运行时依赖是否只允许白名单（本插件允许且仅允许飞书官方 SDK）；
 * 4. patch 是否只激活自己、peer 是否只声明平台包且标 optional。
 *
 * 与「零运行时依赖」的 IM 桥不同：本插件的传输层是飞书官方 Node SDK
 * （见 docs/design/方案设计.md 决策 6.1），因此白名单里有它，其余一律拒绝。
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, listFiles } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
}

async function exists(relativePath) {
  try {
    await stat(join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

const toPosix = (absolute) => relative(root, absolute).split(sep).join('/');

const manifest = await readJson('package.json');
const packageName = manifest.name;

// 0. 产物目录先兜一道：新克隆上直接跑 verify 是最常见的用法。
if (!(await exists('lib'))) {
  process.stderr.write('打包校验失败：缺少 lib/，先跑 npm run build\n');
  process.exit(1);
}

// 1. 必需文件
const required = [
  'cordis.patch.yml',
  'locale/zh.json',
  'locale/en.json',
  'assets/icon.svg',
  'README.md',
  'LICENSE',
  'scripts/build.mjs',
  'tsconfig.json',
  'lib/index.js',
];
for (const file of required) {
  if (!(await exists(file))) {
    const hint = file.startsWith('lib/') ? '（先跑 npm run build）' : '';
    fail(`缺少必需文件：${file}${hint}`);
  }
}

// 2. 清单字段：入口必须指向构建产物
if (manifest.exports?.['.'] !== './lib/index.js') {
  fail("exports['.'] 必须指向构建产物 ./lib/index.js");
}
if (manifest.main !== './lib/index.js') fail('main 必须指向构建产物 ./lib/index.js');
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  fail('package.json 的 dsh.bundle.patch 必须指向 ./cordis.patch.yml');
}
if (manifest.dsh?.client?.platform !== 'web') {
  fail("package.json 的 dsh.client.platform 必须是 'web'");
}
if (manifest.type !== 'module') fail("package.json 的 type 必须是 'module'");
if (!Array.isArray(manifest.dsh?.client?.inject) || manifest.dsh.client.inject.length === 0) {
  fail('package.json 的 dsh.client.inject 必须声明面板依赖的包级顺序');
}

// 3. 运行时依赖白名单：只有飞书官方 SDK 可以进 dependencies。
//    「顺手引个库」必须在这里翻车，不能只靠人肉评审。
const RUNTIME_ALLOWLIST = new Set(['@larksuiteoapi/node-sdk']);
const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies'];
for (const field of RUNTIME_FIELDS) {
  const deps = Object.keys(manifest[field] ?? {});
  for (const name of deps) {
    if (!RUNTIME_ALLOWLIST.has(name)) {
      fail(`${field} 只允许白名单依赖（当前仅飞书官方 SDK）：${name}`);
    }
  }
}
const pinned = manifest.dependencies?.['@larksuiteoapi/node-sdk'];
if (typeof pinned !== 'string' || pinned === '' || /^[\^~]/.test(pinned)) {
  fail('dependencies["@larksuiteoapi/node-sdk"] 必须钉死具体版本（SDK 升级单独提交）');
}
const DEV_ALLOWLIST = new Set(['typescript', 'esbuild', '@types/node', '@types/react']);
for (const name of Object.keys(manifest.devDependencies ?? {})) {
  if (!DEV_ALLOWLIST.has(name)) fail(`devDependencies 不在白名单：${name}`);
}

// 4. peer 只声明平台包且标 optional（npm 不装副本，只作兼容声明）
for (const name of Object.keys(manifest.peerDependencies ?? {})) {
  if (!name.startsWith('@deepseek-ai/')) {
    fail(`peerDependencies 只允许声明宿主平台包：${name}`);
  } else if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
    fail(`peerDependencies['${name}'] 必须标 optional：否则 npm 会装一份宿主包副本`);
  }
}

// 5. patch 只激活自己
const patch = (await readFile(join(root, 'cordis.patch.yml'), 'utf8')).trim();
if (!patch.includes(`id: ${packageName}`)) {
  fail(`cordis.patch.yml 必须以 id: ${packageName} 插入自己的行`);
}
if (patch.includes('remove:') || patch.includes('replace')) {
  fail('cordis.patch.yml 只允许 insert 自己的行，不允许 remove/replace');
}

// 6. 产物确定性：重建到临时目录逐字节比对
const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-im-lark-verify-'));
try {
  const rebuilt = await build({ outDir: join(tempRoot, 'lib') });
  const installed = await listFiles(join(root, 'lib'));
  const installedNames = installed.map((file) => relative(join(root, 'lib'), file).split(sep).join('/')).sort();
  const rebuiltNames = rebuilt.files
    .map((file) => relative(join(tempRoot, 'lib'), file).split(sep).join('/'))
    .sort();
  if (JSON.stringify(installedNames) !== JSON.stringify(rebuiltNames)) {
    fail(
      'lib/ 与源码重建结果文件清单不一致（源码改了但忘了 npm run build？）\n' +
        `  已安装：${installedNames.join(', ')}\n` +
        `  重建：  ${rebuiltNames.join(', ')}`,
    );
  } else {
    for (const name of installedNames) {
      const a = await readFile(join(root, 'lib', name));
      const b = await readFile(join(tempRoot, 'lib', name));
      if (!a.equals(b)) fail(`lib/${name} 与源码重建结果不一致（忘了 npm run build？）`);
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(`打包校验失败（${failures.length} 项）：\n${failures.map((f) => ` - ${f}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('打包校验通过：产物可由源码确定性重建，清单与依赖合规。\n');
