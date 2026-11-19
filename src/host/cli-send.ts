/**
 * 出站快捷命令 `dsh-lark-send`：模型或脚本把一段文本发到主人的飞书。
 *
 * 收件人恒为主人（第一条私聊消息认下来的那个会话），没有 `--to`：给任意人发消息
 * 的能力不该出现在命令行里。
 *
 * 退出码：0 成功；1 发送或前置条件失败；2 参数写错。
 */

import { createSdkLarkApi } from './lark/api.ts';
import type { LarkApi, SdkClientLike } from './lark/api.ts';
import { createSdkClient } from './lark/sdk.ts';
import type { LarkCredentials } from './lark/types.ts';
import { OutboundChannel } from './outbound.ts';
import { DEFAULT_MAX_TEXT_CHARS } from '../shared/limits.ts';
import { resolveDataDir } from './state/paths.ts';
import { CredentialStore } from './state/credentials.ts';
import { OwnerStore } from './state/direct.ts';

export const USAGE = `dsh-lark-send — 把文本发到主人的飞书

用法：
  dsh-lark-send text <正文>    发一条文本
  dsh-lark-send status         查看凭据与收件人是否就绪
  dsh-lark-send help           这份说明

说明：
  · 收件人固定是主人（第一个在飞书里私聊机器人的人），不支持指定别人。
  · 文本按平台上限分条发送；Markdown 以卡片渲染。
  · 需要先在插件面板里配好 App ID / App Secret，并且主人给机器人发过消息。

退出码：0 成功；1 发送或前置条件失败；2 参数写错。
`;

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'text'; text: string };

/** 只认文档里写过的形状，其余按用法错误处理。 */
export function parseArgs(argv: readonly string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === '' || first === 'help' || first === '--help' || first === '-h') {
    return { kind: 'help' };
  }
  if (first === 'status') return { kind: 'status' };
  if (first === 'text') {
    const text = rest.join(' ').trim();
    return text === '' ? { kind: 'help' } : { kind: 'text', text };
  }
  return { kind: 'help' };
}

export interface CliPorts {
  loadApp(): Promise<LarkCredentials | null>;
  ownerChat(): Promise<string | null>;
  createApi(app: LarkCredentials): LarkApi;
  write(line: string): void;
}

export interface CliOptions {
  maxText?: number;
  ports?: CliPorts;
}

/** 运行一次 CLI；返回进程退出码。 */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const ports = options.ports ?? defaultPorts();
  const command = parseArgs(argv);

  if (command.kind === 'help') {
    ports.write(USAGE);
    return 0;
  }

  const app = await ports.loadApp();
  if (app === null) {
    ports.write('还没有配置凭据：先在插件面板里填 App ID 与 App Secret。');
    return 1;
  }

  if (command.kind === 'status') {
    const chat = await ports.ownerChat();
    ports.write(
      [
        `App ID：…${app.appId.slice(-6)}（${app.domain === 'lark' ? 'Lark' : '飞书'}）`,
        `收件人：${chat === null ? '还没有主人（先在飞书里私聊机器人）' : '已绑定'}`,
      ].join('\n'),
    );
    return 0;
  }

  const chatId = await ports.ownerChat();
  if (chatId === null) {
    ports.write('还没有主人：先在飞书里给机器人发一条私聊消息。');
    return 1;
  }

  const api = ports.createApi(app);
  const outbound = new OutboundChannel({ api, maxText: options.maxText ?? DEFAULT_MAX_TEXT_CHARS });
  const receipt = await outbound.deliver({ deliveryId: `cli-${Date.now()}`, chatId, text: command.text });

  if (receipt.errorCode !== undefined) {
    ports.write(`发送失败：${receipt.error ?? receipt.errorCode}`);
    return 1;
  }
  ports.write(`已发送（${receipt.messagesSent} 条）。`);
  return 0;
}

function defaultPorts(): CliPorts {
  const dataDir = resolveDataDir(undefined);
  const credentials = new CredentialStore({ dataDir });
  const owners = new OwnerStore({ dataDir });

  return {
    loadApp: () => credentials.load(),
    ownerChat: async () => {
      const owner = await owners.get();
      return owner === null || owner.chatId === '' ? null : owner.chatId;
    },
    createApi: (app) =>
      createSdkLarkApi({ client: createSdkClient(app) as unknown as SdkClientLike }),
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  };
}
