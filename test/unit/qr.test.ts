import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { encodeQr } from '../../src/host/qr.ts';

function hashOf(text: string): { size: number; hash: string } {
  const qr = encodeQr(text);
  assert.equal(qr.modules.length, qr.size * qr.size);
  assert.ok(qr.modules.every((value) => value === 0 || value === 1));
  return { size: qr.size, hash: createHash('sha256').update(qr.modules.join('')).digest('hex') };
}

test('二维码：固定向量与 oracle 逐模块比对过的矩阵一致', () => {
  // 期望值来自 npm qrcode@1.5.4（强制 byte 模式、mask 0）的矩阵；
  // 同一次验证里还用 jsQR 实际解码过渲染结果。
  assert.deepEqual(hashOf('https://accounts.feishu.cn/oauth/v1/app/registration?user_code=ABCD-EFGH'), {
    size: 33,
    hash: '3952c9c5d20e581d37dfec363d450c5ccc04954dde208a74d09201a2ef4e2aaa',
  });
  assert.deepEqual(hashOf('https://open.feishu.cn'), {
    size: 25,
    hash: '8b4f37e73cdbc7dc97f45ed52a423d24e92641c441d6d94b29f1b372eb265de3',
  });
});

test('二维码：版本自适应，短内容用最小版本', () => {
  assert.equal(encodeQr('x').size, 21);
  assert.equal(encodeQr('a'.repeat(17)).size, 21);
  // 17 字节是 v1-L 的容量上限，多一个字节就要升到 v2。
  assert.equal(encodeQr('a'.repeat(18)).size, 25);
});

test('二维码：UTF-8 内容按字节模式编码', () => {
  const qr = encodeQr('中文二维码');
  assert.equal(qr.size, 21);
  assert.equal(qr.modules.length, 21 * 21);
});

test('二维码：功能图形符合规范（定位、时序、固定深色模块）', () => {
  const qr = encodeQr('https://open.feishu.cn');
  const at = (x: number, y: number): number => qr.modules[y * qr.size + x]!;

  // 左上定位图形：外框深、第二圈浅、中心 3×3 深。
  assert.equal(at(0, 0), 1);
  assert.equal(at(1, 1), 0);
  assert.equal(at(2, 2), 1);
  assert.equal(at(3, 3), 1);

  // 时序图形：第 6 行/列在定位图形之间交替。
  assert.equal(at(8, 6), 1);
  assert.equal(at(9, 6), 0);
  assert.equal(at(6, 8), 1);
  assert.equal(at(6, 9), 0);

  // 固定深色模块。
  assert.equal(at(8, qr.size - 8), 1);
});

test('二维码：超出最大版本容量时明确报错', () => {
  assert.throws(() => encodeQr('a'.repeat(3000)), /内容过长/u);
});
