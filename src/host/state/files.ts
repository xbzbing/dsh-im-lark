/**
 * 私密文件读写。
 *
 * 状态目录里有凭据，所以：目录 `0700`、文件 `0600`、写用「临时文件 + rename」的
 * 原子替换（写一半断电不会留下半个 JSON，那会让插件下次启动直接读不出配置）。
 */

import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface StateLogger {
  warn?(...args: unknown[]): unknown;
  debug?(...args: unknown[]): unknown;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 建目录（含父级）并收紧权限；已存在时也重设一次。 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await chmod(dir, DIR_MODE);
  } catch {
    // 某些文件系统（如挂载的卷）不支持 chmod；不影响功能，忽略。
  }
}

/**
 * 原子写一个私密文件。
 *
 * 先写 `目标.tmp-<随机>`，再 rename 覆盖。rename 在同一目录内是原子的。
 */
export async function writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await writeFile(temp, content, { mode: FILE_MODE });
    try {
      await chmod(temp, FILE_MODE);
    } catch {
      // 同上：权限收紧失败不阻断写入。
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 读 JSON；文件不存在返回 undefined，解析失败按「没有」处理并记一条 warn。 */
export async function readJsonIfPresent(path: string, logger: StateLogger = {}): Promise<unknown> {
  let text: string;
  try {
    text = await readFileText(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    logger.warn?.(`状态文件不是合法 JSON，按空处理：${path}`);
    return undefined;
  }
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT'
  );
}

/**
 * 同步读 JSON，仅用于「进程启动早期就得知道」的场景（目前没有）。
 *
 * 保留它是为了让调用方不必自己处理 ENOENT 与解析异常——需要时直接替换
 * `readJsonIfPresent` 的 await。
 */
export function readJsonSync(path: string, logger: StateLogger = {}): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    logger.warn?.(`状态文件不是合法 JSON，按空处理：${path}`);
    return undefined;
  }
}
