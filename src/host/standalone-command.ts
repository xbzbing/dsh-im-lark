/**
 * 独立模式的文本命令：解析与帮助文案。
 *
 * 纯函数、不碰会话状态，与 `standalone.ts` 的会话编排分开——命令表会随功能长，
 * 编排代码读起来才不用来回翻命令分支。
 *
 * `/send` 的参数按「第一个空白前是会话引用、后面全是内容」解析，内容里的换行与
 * 连续空格原样保留：发给目标会话的是主人写的那段话，不是压平后的一行。
 */

export type StandaloneCommand =
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'sessions'; page?: number }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'trace' }
  | { kind: 'send'; ref: string; text: string }
  | { kind: 'unknown'; name: string };

// 命令名后面必须是空白或结尾：`/sendabc` 不会被当成 `/send`，会落到未知命令。
const COMMAND_PATTERN = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i;

/** 解析以 `/` 开头的文本；不是命令返回 null。 */
export function parseCommand(input: string): StandaloneCommand | null {
  const trimmed = input.trim();
  if (trimmed === '/') return { kind: 'help' };
  const match = COMMAND_PATTERN.exec(trimmed);
  if (match === null) return null;

  const name = match[1]!.toLowerCase();
  const rest = (match[2] ?? '').trim();

  switch (name) {
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
      return parseSend(rest);
    case 'sessions':
      return parseSessions(rest);
    default:
      return { kind: 'unknown', name };
  }
}

function parseSend(rest: string): StandaloneCommand {
  if (rest === '') return { kind: 'send', ref: '', text: '' };
  const space = rest.search(/\s/);
  if (space < 0) return { kind: 'send', ref: rest, text: '' };
  return { kind: 'send', ref: rest.slice(0, space), text: rest.slice(space + 1).trim() };
}

function parseSessions(rest: string): StandaloneCommand {
  if (rest === '') return { kind: 'sessions' };
  const page = Number(rest);
  return Number.isInteger(page) && page > 0 ? { kind: 'sessions', page } : { kind: 'sessions' };
}

export const HELP_TEXT = [
  '我是这个工作区的飞书入口。可用命令：',
  '',
  '`/new` 开新会话',
  '`/sessions [页码]` 列出最近会话与序号',
  '`/send <序号或会话 id> <内容>` 发到指定会话，那一轮的回答回到这里',
  '`/status` 当前会话与连接状态',
  '`/stop` 中止正在跑的回合',
  '`/trace` 上一条回答的模型与耗时',
  '`/help` 这份说明',
].join('\n');
