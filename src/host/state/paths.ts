/**
 * 本机状态目录。
 *
 * 两类目录必须分开（否则凭据会跟着工作区一起被会话读到）：
 * - **状态目录** `$DSH_HOME/.dsh-im-lark/`：凭据、设置与主人/会话绑定；
 * - **默认工作区** `$DSH_HOME/dsh-im-lark/`：独立模式建会话的 cwd，里面没有任何凭据。
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 插件在 `$DSH_HOME` 下的目录名。 */
export const STATE_DIR_NAME = '.dsh-im-lark';

/** 独立模式默认工作区的目录名。 */
export const WORKSPACE_DIR_NAME = 'dsh-im-lark';

/** 解析 `$DSH_HOME`：环境变量优先，其次 `~/.dsh`。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim());
  return join(homedir(), '.dsh');
}

/** 解析状态目录；显式配置优先。 */
export function resolveDataDir(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (configured !== undefined && configured !== '') return resolve(configured);
  return join(resolveDshHome(env), STATE_DIR_NAME);
}

/** 默认工作区目录。 */
export function resolveDefaultWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), WORKSPACE_DIR_NAME);
}
