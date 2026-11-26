import assert from 'node:assert/strict';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { DirectBindingStore, OwnerStore, frontSessionOf } from '../../src/host/state/direct.ts';
import { withTempDir } from './helpers/temp.ts';

test('绑定：写盘后新实例能读回，文件权限 0600', async () => {
  await withTempDir(async (dir) => {
    const store = new DirectBindingStore({ dataDir: dir.path });
    await store.set({ sessionId: 's_1', workspaceId: 'ws_1', title: '飞书 · abcdef' });

    const reopened = new DirectBindingStore({ dataDir: dir.path });
    assert.deepEqual(await reopened.get(), {
      sessionId: 's_1',
      workspaceId: 'ws_1',
      title: '飞书 · abcdef',
      frontSessionId: 's_1',
      frontTitle: '飞书 · abcdef',
    });

    const mode = (await stat(dir.at('direct.json'))).mode & 0o777;
    assert.equal(mode.toString(8), '600');
  });
});

test('绑定：/switch 的标记与标题一起读回', async () => {
  await withTempDir(async (dir) => {
    const store = new DirectBindingStore({ dataDir: dir.path });
    await store.set({ sessionId: 's_2', workspaceId: '', title: '乙', switched: true });

    const reopened = new DirectBindingStore({ dataDir: dir.path });
    assert.deepEqual(await reopened.get(), { sessionId: 's_2', workspaceId: '', title: '乙', switched: true });
  });
});

test('绑定：旧版未切换的绑定把当前会话当前台', async () => {
  await withTempDir(async (dir) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(dir.at('direct.json'), JSON.stringify({ sessionId: 's_1', workspaceId: '', title: '甲' }), 'utf8');
    const binding = await new DirectBindingStore({ dataDir: dir.path }).get();
    assert.equal(binding?.frontSessionId, 's_1');
    assert.equal(binding?.frontTitle, '甲');
  });
});

test('绑定：切走后可以单独更新前台标题', async () => {
  await withTempDir(async (dir) => {
    const store = new DirectBindingStore({ dataDir: dir.path });
    await store.set({ sessionId: 's_2', workspaceId: '', title: '乙', switched: true, frontSessionId: 's_1', frontTitle: '甲' });

    await store.setTitle('新甲', 's_1');
    const binding = await store.get();
    assert.equal(binding?.title, '乙');
    assert.equal(binding?.frontSessionId, 's_1');
    assert.equal(binding?.frontTitle, '新甲');
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

test('主人：核心绑定结果可以镜像进来，不改别的 open_id', async () => {
  await withTempDir(async (dir) => {
    const owners = new OwnerStore({ dataDir: dir.path });
    await owners.remember('ou_a', 'oc_1');
    assert.deepEqual(await owners.get(), { openId: 'ou_a', chatId: 'oc_1' });

    await owners.remember('ou_a', 'oc_2');
    assert.deepEqual(await owners.get(), { openId: 'ou_a', chatId: 'oc_2' });

    await owners.remember('ou_b', 'oc_3');
    assert.deepEqual(await owners.get(), { openId: 'ou_a', chatId: 'oc_2' });
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

test('前台：空绑定、旧版未切换、切走有/无记录', () => {
  assert.equal(frontSessionOf(null), null);
  assert.deepEqual(frontSessionOf({ sessionId: 's_1', workspaceId: '', title: '甲' }), {
    sessionId: 's_1',
    title: '甲',
  });
  assert.equal(frontSessionOf({ sessionId: 's_2', workspaceId: '', switched: true }), null);
  assert.deepEqual(
    frontSessionOf({ sessionId: 's_2', workspaceId: '', switched: true, frontSessionId: 's_1', frontTitle: '甲' }),
    { sessionId: 's_1', title: '甲' },
  );
});

test('绑定：写入队列让标题与绑定变更按提交顺序合并', async () => {
  await withTempDir(async (dir) => {
    const store = new DirectBindingStore({ dataDir: dir.path });
    await store.set({ sessionId: 's_2', workspaceId: '', title: '乙', switched: true, frontSessionId: 's_1', frontTitle: '甲' });

    const title = store.setTitle('新甲', 's_1');
    const switched = store.update((current) => {
      if (current === null) return undefined;
      return { ...current, sessionId: 's_3', workspaceId: '', title: '丙' };
    });
    await Promise.all([title, switched]);

    const binding = await store.get();
    assert.equal(binding?.sessionId, 's_3');
    assert.equal(binding?.frontSessionId, 's_1');
    assert.equal(binding?.frontTitle, '新甲');
  });
});

test('绑定：drain 等到排队写入落盘', async () => {
  await withTempDir(async (dir) => {
    const store = new DirectBindingStore({ dataDir: dir.path });
    const writing = store.set({ sessionId: 's_1', workspaceId: '', title: '甲' });
    await store.drain();
    await writing;

    const reopened = new DirectBindingStore({ dataDir: dir.path });
    assert.equal((await reopened.get())?.sessionId, 's_1');
  });
});

test('绑定：前台标题跨重启保留', async () => {
  await withTempDir(async (dir) => {
    const store = new DirectBindingStore({ dataDir: dir.path });
    await store.set({ sessionId: 's_2', workspaceId: '', title: '乙', switched: true, frontSessionId: 's_1', frontTitle: '新甲' });
    await store.drain();

    const reopened = new DirectBindingStore({ dataDir: dir.path });
    assert.equal((await reopened.get())?.frontTitle, '新甲');
  });
});

test('绑定：一次写失败后队列仍能继续', async () => {
  await withTempDir(async (dir) => {
    const state = dir.at('state');
    await writeFile(state, 'not a directory', 'utf8');
    const store = new DirectBindingStore({ dataDir: state });
    await assert.rejects(store.set({ sessionId: 's_1', workspaceId: '' }));

    await rm(state, { force: true });
    await mkdir(state, { recursive: true });
    await store.set({ sessionId: 's_1', workspaceId: '', title: '甲' });
    assert.equal((await store.get())?.title, '甲');
  });
});

test('绑定：并发 get 只读一份', async () => {
  await withTempDir(async (dir) => {
    await writeFile(dir.at('direct.json'), JSON.stringify({ sessionId: 's_1', workspaceId: '' }), 'utf8');
    const store = new DirectBindingStore({ dataDir: dir.path });
    const [first, second] = await Promise.all([store.get(), store.get()]);
    assert.equal(first, second);
  });
});
