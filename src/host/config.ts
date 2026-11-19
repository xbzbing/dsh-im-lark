/**
 * 插件配置：Cordis 传入的静态配置 + 面板能改的那几项。
 *
 * 配置分两层：
 * - **静态配置**来自 profile 的 patch（`dataDir`、`domain`、`maxText` 等），改了要重启；
 * - **运行设置**是面板上的「接入飞书」「接入我的超级助理」等，落在
 *   `$DSH_HOME/.dsh-im-lark/config.json`，卸载重装后沿用。
 *
 * 外部输入（宿主给的配置对象、磁盘上的 JSON）在这里收窄成确定形状，领域内部
 * 不再做防御式判空。
 */

import { join, resolve } from 'node:path';

import { DEFAULT_MAX_TEXT_CHARS } from '../shared/limits.ts';
import { readJsonIfPresent, writePrivateFile } from './state/files.ts';
import type { StateLogger } from './state/files.ts';
import { resolveDataDir } from './state/paths.ts';
import type { LarkDomain } from './lark/types.ts';

export type BusyMode = 'interrupt' | 'queue';

/** 独立模式里回合正在跑时又来一条消息的提交方式。 */
export const DEFAULT_DIRECT_BUSY_MODE: BusyMode = 'interrupt';

export interface PluginConfig {
  /** 静态默认开关：是否接入飞书（收发）。 */
  enabled?: boolean;
  /** 静态默认开关：是否接入「我的超级助理」。 */
  superagent?: boolean;
  /** 覆盖状态目录（默认 `$DSH_HOME/.dsh-im-lark`）。 */
  dataDir?: string;
  /** 覆盖平台域名：feishu（默认）或 lark。 */
  domain?: LarkDomain;
  /** 单条消息上限，按字符计（默认 2000）。 */
  maxText?: number;
  /** 是否在用户消息上加「正在处理」表情，默认开。 */
  typingIndicator?: boolean;
  /** 独立模式建会话的工作区 id；空表示自动创建的默认工作区。 */
  directWorkspaceId?: string;
  /** 独立模式里回合正在跑时又来一条消息的提交方式。 */
  directBusyMode?: BusyMode;
  /** 独立模式回复末尾是否附加模型、推理等级、消耗 token 与时间；默认关。 */
  replyStatus?: boolean;
  /** 面板 RPC 的路径段，默认包名。 */
  rpcPath?: string;
}

/** 收窄后的配置：所有可选字段都有确定值。 */
export interface NormalizedConfig {
  enabled: boolean;
  superagent: boolean;
  dataDir: string;
  domain: LarkDomain;
  maxText: number;
  typingIndicator: boolean;
  directWorkspaceId: string | undefined;
  directBusyMode: BusyMode;
  replyStatus: boolean;
  rpcPath: string;
}

const MIN_MAX_TEXT = 200;
const MAX_MAX_TEXT = 20_000;

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asIntegerInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

function asBusyMode(value: unknown): BusyMode | undefined {
  return value === 'interrupt' || value === 'queue' ? value : undefined;
}

function asDomain(value: unknown): LarkDomain | undefined {
  return value === 'feishu' || value === 'lark' ? value : undefined;
}

/** 把外部配置收窄成确定形状；非法值一律回落到默认，不抛错（否则插件装不上）。 */
export function normalizePluginConfig(raw: unknown): NormalizedConfig {
  const input = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  return {
    enabled: asBoolean(input.enabled) ?? true,
    superagent: asBoolean(input.superagent) ?? false,
    dataDir: resolveDataDir(asString(input.dataDir)),
    domain: asDomain(input.domain) ?? 'feishu',
    maxText: asIntegerInRange(input.maxText, MIN_MAX_TEXT, MAX_MAX_TEXT) ?? DEFAULT_MAX_TEXT_CHARS,
    typingIndicator: asBoolean(input.typingIndicator) ?? true,
    directWorkspaceId: asString(input.directWorkspaceId),
    directBusyMode: asBusyMode(input.directBusyMode) ?? DEFAULT_DIRECT_BUSY_MODE,
    replyStatus: asBoolean(input.replyStatus) ?? false,
    rpcPath: asString(input.rpcPath) ?? 'dsh-im-lark',
  };
}

/**
 * 面板能改的运行设置。
 *
 * 只有这几项会落盘：连接凭据单独存（见 `state/credentials.ts`），其余静态配置
 * 留在 profile 的 patch 里——两处都能改同一件事会让「生效的是哪一份」说不清。
 */
export interface LocalSettings {
  /** 是否接入飞书（收消息）。 */
  enabled: boolean;
  /** 是否接入「我的超级助理」。 */
  superagent: boolean;
  /** 独立模式的工作区 id（空串表示默认工作区）。 */
  directWorkspaceId: string;
  /** 独立模式回合内的提交方式。 */
  directBusyMode: BusyMode;
  /** 独立模式回复是否附加状态行。 */
  replyStatus: boolean;
  /** 是否在用户消息上加「正在处理」表情。 */
  typingIndicator: boolean;
}

export function defaultSettings(config: NormalizedConfig): LocalSettings {
  return {
    enabled: config.enabled,
    superagent: config.superagent,
    directWorkspaceId: config.directWorkspaceId ?? '',
    directBusyMode: config.directBusyMode,
    replyStatus: config.replyStatus,
    typingIndicator: config.typingIndicator,
  };
}

/** 收窄磁盘上的设置：缺字段用默认值补，非法值忽略。 */
export function normalizeSettings(raw: unknown, config: NormalizedConfig): LocalSettings {
  const fallback = defaultSettings(config);
  if (raw === null || raw === undefined || typeof raw !== 'object') return fallback;
  const input = raw as Record<string, unknown>;

  return {
    enabled: asBoolean(input.enabled) ?? fallback.enabled,
    superagent: asBoolean(input.superagent) ?? fallback.superagent,
    directWorkspaceId: asString(input.directWorkspaceId) ?? fallback.directWorkspaceId,
    directBusyMode: asBusyMode(input.directBusyMode) ?? fallback.directBusyMode,
    replyStatus: asBoolean(input.replyStatus) ?? fallback.replyStatus,
    typingIndicator: asBoolean(input.typingIndicator) ?? fallback.typingIndicator,
  };
}

/** 设置文件路径。 */
export function settingsPath(dataDir: string): string {
  return join(resolve(dataDir), 'config.json');
}

/** 面板可改设置的读写；一次读、按需写，写用私密原子写。 */
export class LocalConfigStore {
  readonly #path: string;
  readonly #config: NormalizedConfig;
  readonly #logger: StateLogger;
  #settings: LocalSettings | null = null;

  constructor(options: { dataDir: string; config: NormalizedConfig; logger?: StateLogger }) {
    this.#path = settingsPath(options.dataDir);
    this.#config = options.config;
    this.#logger = options.logger ?? {};
  }

  async load(): Promise<LocalSettings> {
    if (this.#settings) return this.#settings;
    const raw = await readJsonIfPresent(this.#path, this.#logger);
    this.#settings = normalizeSettings(raw, this.#config);
    return this.#settings;
  }

  /** 当前视图（必须先 `load()`）。 */
  get current(): LocalSettings {
    if (!this.#settings) throw new Error('设置尚未加载：先 await load()');
    return this.#settings;
  }

  async save(patch: Partial<LocalSettings>): Promise<LocalSettings> {
    const current = await this.load();
    const next: LocalSettings = { ...current, ...patch };
    await writePrivateFile(this.#path, `${JSON.stringify(next, null, 2)}\n`);
    this.#settings = next;
    return next;
  }
}
