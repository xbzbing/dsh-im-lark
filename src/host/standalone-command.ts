/**
 * 独立模式的文本命令：解析与帮助文案。
 *
 * 纯函数、不碰会话状态，与 `standalone.ts` 的会话编排分开——命令表会随功能长，
 * 编排代码读起来才不用来回翻命令分支。
 */

export type StandaloneCommand =
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'sessions'; index?: number }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'trace' }
  | { kind: 'send'; text: string }
  | { kind: 'unknown'; name: string };

/** 解析以 `/` 开头的文本；不是命令返回 null。 */
export function parseCommand(input: string): StandaloneCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const [head = '', ...rest] = trimmed.slice(1).split(/\s+/);
  const name = head.toLowerCase();
  const tail = rest.join(' ').trim();

  switch (name) {
    case '':
    case 'help':
      return { kind: 'help' };
    case 'new':
      return { kind: 'new' };
    case 'status':
      return { kind: 'status' };
    case 'stop':
      return { kind: 'stop' };
    case 'trace':
      return { kind: 'trace' };
    case 'send':
      return tail === '' ? { kind: 'help' } : { kind: 'send', text: tail };
    case 'sessions': {
      if (tail === '') return { kind: 'sessions' };
      const index = Number(tail);
      return Number.isInteger(index) && index > 0 ? { kind: 'sessions', index } : { kind: 'sessions' };
    }
    default:
      return { kind: 'unknown', name };
  }
}

export const HELP_TEXT = [
  '我是这个工作区的飞书入口。可用命令：',
  '',
  '`/new` 开新会话',
  '`/sessions` 查看最近会话；`/sessions 2` 切到第 2 个',
  '`/status` 当前会话与连接状态',
  '`/stop` 中止正在跑的回合',
  '`/trace` 上一条回答的模型与耗时',
  '`/send <文本>` 不经过模型，直接发一段文本',
  '`/help` 这份说明',
].join('\n');
