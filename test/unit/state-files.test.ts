import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { writePrivateFile } from '../../src/host/state/files.ts';
import { withTempDir } from './helpers/temp.ts';

test('私密文件：并发写同一路径不互相踩临时文件', async () => {
  await withTempDir(async (dir) => {
    const target = dir.at('state.json');
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => writePrivateFile(target, `value-${index}`)),
    );
    const content = await readFile(target, 'utf8');
    assert.match(content, /^value-\d+$/);
    assert.deepEqual((await readdir(dir.path)).filter((name) => name.includes('.tmp-')), []);
  });
});

test('私密文件：rename 失败后清掉临时文件', async () => {
  await withTempDir(async (dir) => {
    const target = dir.at('state.json');
    await (await import('node:fs/promises')).mkdir(target);
    await assert.rejects(writePrivateFile(target, 'value'));
    assert.deepEqual((await readdir(dir.path)).filter((name) => name.includes('.tmp-')), []);
  });
});
