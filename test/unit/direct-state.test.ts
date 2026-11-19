import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { test } from 'node:test';

import { DirectBindingStore, OwnerStore } from '../../src/host/state/direct.ts';
import { withTempDir } from './helpers/temp.ts';

test('绑定：写盘后新实例能读回，文件权限 0600', async () => {
  await withTempDir(async (dir) => {
    const store = new DirectBindingStore({ dataDir: dir.path });
    await store.set({ sessionId: 's_1', workspaceId: 'ws_1', title: '飞书 · abcdef' });

    const reopened = new DirectBindingStore({ dataDir: dir.path });
    assert.deepEqual(await reopened.get(), { sessionId: 's_1', workspaceId: 'ws_1', title: '飞书 · abcdef' });

    const mode = (await stat(dir.at('direct.json'))).mode & 0o777;
    assert.equal(mode.toString(8), '600');
  });
});

test('绑定：改标题不丢会话；清除后回到 null', async () => {
  await withTempDir(async (dir) => {
    const store = new DirectBindingStore({ dataDir: dir.path });
    await store.set({ sessionId: 's_1', workspaceId: '' });

    await store.setTitle('新标题');
    assert.equal((await store.get())?.title, '新标题');
    assert.equal((await store.get())?.sessionId, 's_1');

    await store.clear();
    assert.equal(await store.get(), null);
    assert.equal(new DirectBindingStore({ dataDir: dir.path }).peek(), null);
  });
});

test('绑定：损坏或字段不全的文件按未绑定处理', async () => {
  await withTempDir(async (dir) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dir.at('direct.json'), '{ 坏掉的 JSON', 'utf8');
    assert.equal(await new DirectBindingStore({ dataDir: dir.path }).get(), null);

    await writeFile(dir.at('direct.json'), JSON.stringify({ workspaceId: 'x' }), 'utf8');
    assert.equal(await new DirectBindingStore({ dataDir: dir.path }).get(), null);
  });
});

test('主人：第一个认领者生效，之后不能被改写', async () => {
  await withTempDir(async (dir) => {
    const owners = new OwnerStore({ dataDir: dir.path });

    assert.equal(await owners.get(), null);
    assert.deepEqual(await owners.claim('ou_a', 'oc_1'), { openId: 'ou_a', chatId: 'oc_1' });
    assert.deepEqual(await owners.claim('ou_b', 'oc_2'), { openId: 'ou_a', chatId: 'oc_1' });

    assert.equal(await owners.isOwner('ou_a'), true);
    assert.equal(await owners.isOwner('ou_b'), false);
  });
});

test('主人：记住最近活跃会话，重启后仍认得主人', async () => {
  await withTempDir(async (dir) => {
    const owners = new OwnerStore({ dataDir: dir.path });
    await owners.claim('ou_a', 'oc_1');
    await owners.rememberChat('oc_9');

    const reopened = new OwnerStore({ dataDir: dir.path });
    assert.deepEqual(await reopened.get(), { openId: 'ou_a', chatId: 'oc_9' });
    assert.equal(await reopened.isOwner('ou_a'), true);
  });
});

test('主人：清除后可以重新认领（换机器/重装场景）', async () => {
  await withTempDir(async (dir) => {
    const owners = new OwnerStore({ dataDir: dir.path });
    await owners.claim('ou_a', 'oc_1');
    await owners.clear();
    assert.deepEqual(await owners.claim('ou_b', 'oc_2'), { openId: 'ou_b', chatId: 'oc_2' });
  });
});
