/**
 * 面板文案：语言包是 `locale/zh.json` 与 `locale/en.json`，与代码分开放。
 *
 * 中文是键的唯一来源（`LarkKey` 由它派生），英文必须同键；单测会比对两份键集合。
 * 宿主文案服务缺席时用 `fallbackTranslate` 兜底：面板宁可显示中文，也不能把
 * `panel.title` 这样的键名露给用户。
 */

import enPack from '../../locale/en.json' with { type: 'json' };
import zhPack from '../../locale/zh.json' with { type: 'json' };

export const NS = 'dsh-im-lark';

/** 中文语言包：键集合的唯一来源。 */
export const zh = zhPack;

export type LarkKey = keyof typeof zh;

/** 英文语言包：类型约束保证与中文同键。 */
export const en: Record<LarkKey, string> = enPack;

export type TranslateParams = Record<string, string | number>;

export type Translate = (key: LarkKey, params?: TranslateParams) => string;

/** 没有 `ctx.locale` 时的翻译：查中文，插值规则与宿主一致。 */
export function fallbackTranslate(key: LarkKey, params?: TranslateParams): string {
  const template = zh[key] as string;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
