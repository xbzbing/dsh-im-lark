import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planCommand, registerLarkCommand } from '../../src/host/command.ts';
import type { CommandOutcome } from '../../src/host/command.ts';

test('命令：空输入给用法，status 看状态，其余当正文', () => {
  assert.deepEqual(planCommand(''), { kind: 'help' });
  assert.deepEqual(planCommand('help'), { kind: 'help' });
  assert.deepEqual(planCommand('status'), { kind: 'status' });
  assert.deepEqual(planCommand('你好'), { kind: 'text', text: '你好' });
  assert.deepEqual(planCommand('text 你好'), { kind: 'text', text: '你好' });
  assert.deepEqual(planCommand('text   '), { kind: 'help' });
});

interface Registered {
  name: string;
  description: string;
  input?: { hint: string };
  handler: (invocation: { rawInput: string }) => Promise<CommandOutcome> | CommandOutcome;
}

/** 造一个只支持 commands 与 effect 的宿主上下文。 */
function ctxWith(registered: Registered[]): any {
  const ctx = {
    inject(_services: string[], install: (scope: any) => void) {
      install({
        commands: {
          register(definition: Registered) {
            registered.push(definition);
            return () => {
              registered.length = 0;
            };
          },
        },
        effect(work: () => () => void) {
          work();
        },
      });
    },
  };
  return ctx;
}

test('命令：注册后发送正文，成功与失败都回一句话', async () => {
  const registered: Registered[] = [];
  const sent: string[] = [];
  registerLarkCommand(ctxWith(registered), {
    sendText: async (text) => {
      sent.push(text);
      return text === '失败' ? { ok: false, error: '平台拒绝' } : { ok: true };
    },
    statusText: () => '状态行',
  });

  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.name, 'lark');

  const ok = await registered[0]!.handler({ rawInput: '你好' });
  assert.equal(ok.kind, 'success');
  assert.deepEqual(sent, ['你好']);

  const failed = await registered[0]!.handler({ rawInput: '失败' });
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /平台拒绝/);

  const status = await registered[0]!.handler({ rawInput: 'status' });
  assert.equal(status.text, '状态行');
});

test('命令：宿主没有 commands 服务时静默跳过', () => {
  assert.doesNotThrow(() =>
    registerLarkCommand({ inject() {} }, {
      sendText: async () => ({ ok: true }),
      statusText: () => '',
    }),
  );
});
