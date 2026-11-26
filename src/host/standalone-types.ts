/**
 * 独立模式的公共类型：宿主会话控制器的结构类型、提示内容与排队方式。
 *
 * 拆出来是为了让命令编排（`standalone-send.ts`）与提示构造（`prompt-content.ts`）
 * 都能引用，而不必反向依赖 `standalone.ts`。
 */

import type { SessionLister } from './session-list.ts';

export type BusyMode = 'queue' | 'steer';

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string };

/** 宿主 `sessionController` 里独立模式用到的方法（结构类型）。 */
export interface StandaloneController extends SessionLister {
  create(request: { workspaceId?: string }): Promise<{ sessionId: string }>;
  prompt(
    request: {
      requestId: string;
      sessionId: string;
      mode: BusyMode;
      content: readonly PromptPart[];
      clientTimeZone?: string;
    },
    signal: AbortSignal,
  ): Promise<{ accepted?: boolean }>;
  cancel?(request: { sessionId: string }): { accepted?: boolean } | Promise<{ accepted?: boolean }>;
  rename?(request: { sessionId: string; title: string }): Promise<unknown>;
}
