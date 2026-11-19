#!/usr/bin/env node
/**
 * `dsh-lark-send` 的进程入口。
 *
 * 逻辑全在 `src/host/cli-send.ts`（编译到 `lib/src/host/cli-send.js`）：这里只负责
 * 把 argv 转进去、把退出码带出来。卸载/未构建时给出可操作的提示，而不是栈。
 */

let runCli;
try {
  ({ runCli } = await import('../lib/src/host/cli-send.js'));
} catch (error) {
  process.stderr.write(`dsh-lark-send 还没有构建：先在插件目录执行 npm run build\n${String(error?.message ?? error)}\n`);
  process.exit(1);
}

process.exit(await runCli(process.argv.slice(2)));
