import assert from 'node:assert/strict';
import { test } from 'node:test';

import { en, zh } from '../../src/client/locales.ts';

test('语言包：中英文键集合一致，且没有空文案', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en 与 zh 的键必须一一对应');

  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string', `zh.${key} 必须是字符串`);
    assert.ok(value.trim() !== '', `zh.${key} 不能为空`);
  }
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', `en.${key} 必须是字符串`);
    assert.ok(value.trim() !== '', `en.${key} 不能为空`);
  }
});

test('语言包：占位符两边一致', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key} 的占位符不一致`);
  }
});
