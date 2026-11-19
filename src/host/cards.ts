/**
 * 卡片 JSON 构造。
 *
 * 回答统一走**卡片**而不是纯文本：飞书文本消息不渲染 Markdown，卡片里的
 * `markdown` 组件才认标题、列表、表格与代码块。代价是体积上限更小（30 KB），
 * 所以发送前要按字节再卡一道（`outbound.ts`）。
 *
 * 结构以卡片 JSON 2.0 为准（`"schema": "2.0"` + `body.elements`），仅支持共享
 * 卡片，因此 `update_multi` 恒为 `true`，后续才能原地 PATCH。
 */

import { CARD_BODY_BYTES_MAX } from '../shared/limits.ts';

export const CARD_SCHEMA = '2.0';

/** 卡片模板色：只用平台内置枚举，别传自定义色值。 */
export type CardTemplate = 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey';

export interface MarkdownCardOptions {
  /** 卡片标题；不传则没有头部，纯内容卡。 */
  title?: string;
  template?: CardTemplate;
  /** 流式更新模式；流式回答用，普通交付关掉。 */
  streaming?: boolean;
}

/** 一张只含 Markdown 的卡片。 */
export function renderMarkdownCard(markdown: string, options: MarkdownCardOptions = {}): Record<string, unknown> {
  return {
    schema: CARD_SCHEMA,
    config: {
      update_multi: true,
      ...(options.streaming === true ? { streaming_mode: true } : {}),
    },
    ...(options.title === undefined || options.title === ''
      ? {}
      : {
          header: {
            title: { tag: 'plain_text', content: options.title },
            template: options.template ?? 'blue',
          },
        }),
    body: {
      elements: [{ tag: 'markdown', content: markdown, text_size: 'normal' }],
    },
  };
}

/** 卡片序列化后的字节数（UTF-8），发送前用于判断是否超限。 */
export function cardBytes(card: unknown): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}

export function cardFits(card: unknown): boolean {
  return cardBytes(card) <= CARD_BODY_BYTES_MAX;
}

/** 消息体：`content` 字段要的是 JSON 字符串，不是对象。 */
export function cardContent(card: unknown): string {
  return JSON.stringify(card);
}
