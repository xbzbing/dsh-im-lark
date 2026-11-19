/**
 * 测试用的临时目录：每个用例一个，结束即删。
 *
 * 所有涉及落盘的用例都必须用它——测试不许写真实的 `~/.dsh`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDir {
  path: string;
  /** 目录里的某个路径。 */
  at(...segments: string[]): string;
  dispose(): Promise<void>;
}

export async function withTempDir<T>(work: (dir: TempDir) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-lark-test-'));
  const dir: TempDir = {
    path: root,
    at: (...segments) => join(root, ...segments),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
  try {
    return await work(dir);
  } finally {
    await dir.dispose();
  }
}

/** 造一个可控时钟：`now()` 返回当前值，`advance(ms)` 推进。 */
export function fakeClock(start = 1_700_000_000_000): { now(): number; advance(ms: number): void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}
