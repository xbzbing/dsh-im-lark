/**
 * 斜杠命令 `/lark`：人在输入框里直接把一段文字发到自己的飞书。
 *
 * 命令 handler 不经过模型（宿主契约如此），所以这里不读会话、不改上下文，只做
 * 「解析 → 调发送端口 → 回一句话」。模型主动发消息走 `cli-send.ts`。
 */

import { injectOptional } from './host-context.ts';
import type { PluginContext, PluginLogger } from './host-context.ts';
import { USAGE } from './cli-send.ts';

export const COMMAND_NAME = 'lark';

export interface CommandDeps {
  /** 发给主人；失败时给可读原因。 */
  sendText(text: string): Promise<{ ok: boolean; error?: string }>;
  /** 一行状态：凭据是否配好、主人是否认下来。 */
  statusText(): string;
  logger?: PluginLogger;
}

export interface CommandOutcome {
  kind: 'success' | 'error';
  text: string;
}

/**
 * 解析输入：`/lark` 空输入给用法，`/lark status` 看状态，其余都当正文
 * （允许写 `/lark text 你好`，与 CLI 的写法对齐）。
 */
export function planCommand(rawInput: string): { kind: 'help' } | { kind: 'status' } | { kind: 'text'; text: string } {
  const input = rawInput.trim();
  if (input === '' || input === 'help') return { kind: 'help' };
  if (input === 'status') return { kind: 'status' };
  if (input === 'text') return { kind: 'help' };
  const text = input.startsWith('text ') ? input.slice(5).trim() : input;
  return text === '' ? { kind: 'help' } : { kind: 'text', text };
}

interface CommandScope extends PluginContext {
  commands?: {
    register(definition: {
      name: string;
      description: string;
      input?: { hint: string };
      handler: (invocation: { rawInput: string }) => Promise<CommandOutcome> | CommandOutcome;
    }): () => void;
  };
}

/** 注册 `/lark`；宿主没有 commands 服务时静默跳过（CLI 组合）。 */
export function registerLarkCommand(ctx: PluginContext, deps: CommandDeps): void {
  const install = (scope: PluginContext): void => {
    const commands = (scope as CommandScope).commands;
    if (commands === undefined || typeof commands.register !== 'function') {
      deps.logger?.warn?.('斜杠命令未注册：宿主未提供 commands');
      return;
    }

    const handler = async (invocation: { rawInput: string }): Promise<CommandOutcome> => {
      try {
        const plan = planCommand(invocation.rawInput ?? '');
        if (plan.kind === 'help') return { kind: 'success', text: USAGE };
        if (plan.kind === 'status') return { kind: 'success', text: deps.statusText() };

        const result = await deps.sendText(plan.text);
        return result.ok
          ? { kind: 'success', text: `已发送（${plan.text.length} 字）。` }
          : { kind: 'error', text: result.error ?? '发送失败。' };
      } catch (error) {
        deps.logger?.warn?.('斜杠命令失败', error instanceof Error ? error.message : String(error));
        return { kind: 'error', text: '发送失败。' };
      }
    };

    const register = (): (() => void) => commands.register({
      name: COMMAND_NAME,
      description: '把一段文字发到自己的飞书',
      input: { hint: '<正文> | status | help' },
      handler,
    });

    if (typeof scope.effect === 'function') {
      scope.effect(() => {
        const off = register();
        return () => off();
      }, 'dsh-im-lark: /lark 命令');
    } else {
      register();
    }
  };

  injectOptional(ctx, 'commands', install);
}
