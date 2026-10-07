/**
 * 服务器级 WebDAV 设置。
 *
 * 服务器模式下，页面上可直接修改 WebDAV 连接与自动同步参数；这些值存在 SQLite 的
 * `meta` 表里，对所有设备一致。环境变量退化为**首次默认值**：某字段在库里还没有值时，
 * 用环境变量（最终回落到内置默认）落库；之后一律以库里的值为准，重启不丢。
 *
 * 优先级：**库值 > 环境变量 > 内置默认**。
 *
 * 口令只进库、绝不回传前端明文；对外视图只给 `webdavPasswordSet` 布尔。
 * 旧版 `sync-config.ts` 的自动同步开关 / 间隔 / 保留份数复用同一套库键，
 * 由本模块统一读写，避免两个真值来源。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { getMeta, setMeta } from './db.ts';

/** 同步间隔范围（分钟）。 */
export const WEBDAV_INTERVAL_MIN = 1;
export const WEBDAV_INTERVAL_MAX = 1440;
/** 保留份数范围（份）。 */
export const WEBDAV_KEEP_MIN = 1;
export const WEBDAV_KEEP_MAX = 1000;
/** 显式清空口令的哨兵值；字段缺省或空串表示「不修改」。 */
export const WEBDAV_PASSWORD_CLEAR = '__clear__';

/** 库键；沿用旧版 sync-config 的三项键，保证既有部署的设置不丢。 */
const KEYS = {
  relayAllowPrivate: 'relayAllowPrivate',
  enabled: 'syncConfig.enabled',
  intervalMinutes: 'syncConfig.intervalMinutes',
  keep: 'syncConfig.keep',
  url: 'webdav.url',
  username: 'webdav.username',
  password: 'webdav.password',
} as const;

/** 服务器级设置的内部形状（含口令明文，只在服务端内存 / 库中出现）。 */
export interface ServerSettings {
  relayAllowPrivate: boolean;
  webdavEnabled: boolean;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  webdavIntervalMinutes: number;
  webdavKeep: number;
}

/** 对外视图：绝不包含口令明文。 */
export interface ServerSettingsView {
  relayAllowPrivate: boolean;
  webdavEnabled: boolean;
  webdavUrl: string;
  webdavUsername: string;
  /** 库里是否已设置口令；绝不回传口令值。 */
  webdavPasswordSet: boolean;
  webdavIntervalMinutes: number;
  webdavKeep: number;
}

/** 部分更新补丁；未出现的字段不改动。 */
export interface WebdavConfigPatch {
  relayAllowPrivate?: boolean;
  webdavEnabled?: boolean;
  webdavUrl?: string;
  webdavUsername?: string;
  /** 缺省 / 空串 = 不改动；`WEBDAV_PASSWORD_CLEAR` = 清空。 */
  webdavPassword?: string;
  webdavIntervalMinutes?: number;
  webdavKeep?: number;
}

export interface WebdavConfigUpdateResult {
  settings: ServerSettings;
  /** 变了的字段名（不含口令值）；用于审计。 */
  changed: string[];
  passwordChanged: boolean;
}

/** 非法设置：`message` 为可直接展示的中文文案。 */
export class ServerSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerSettingError';
  }
}

/** 环境变量 / 内置默认提供的首次落库值。 */
function envDefaults(config: Config): ServerSettings {
  return {
    relayAllowPrivate: config.webdavRelayAllowPrivate,
    webdavEnabled: config.webdavEnabled,
    webdavUrl: config.webdavUrl,
    webdavUsername: config.webdavUsername,
    webdavPassword: config.webdavPassword,
    webdavIntervalMinutes: config.webdavIntervalMinutes,
    webdavKeep: config.webdavKeep,
  };
}

function readBool(db: DatabaseSync, key: string, fallback: boolean): boolean {
  const raw = getMeta(db, key);
  if (raw === undefined) {
    setMeta(db, key, fallback ? '1' : '0');
    return fallback;
  }
  return raw === '1';
}

function readInt(db: DatabaseSync, key: string, fallback: number, min: number, max: number): number {
  const raw = getMeta(db, key);
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  setMeta(db, key, String(fallback));
  return fallback;
}

function readString(db: DatabaseSync, key: string, fallback: string): string {
  const raw = getMeta(db, key);
  if (raw === undefined) {
    setMeta(db, key, fallback);
    return fallback;
  }
  return raw;
}

/**
 * 读取整套设置；库里缺某字段时按环境变量（内置默认）落库后返回。
 * 优先级：库值 > 环境变量 > 内置默认。
 */
export function readServerSettings(db: DatabaseSync, config: Config): ServerSettings {
  const defaults = envDefaults(config);
  return {
    relayAllowPrivate: readBool(db, KEYS.relayAllowPrivate, defaults.relayAllowPrivate),
    webdavEnabled: readBool(db, KEYS.enabled, defaults.webdavEnabled),
    webdavUrl: readString(db, KEYS.url, defaults.webdavUrl),
    webdavUsername: readString(db, KEYS.username, defaults.webdavUsername),
    webdavPassword: readString(db, KEYS.password, defaults.webdavPassword),
    webdavIntervalMinutes: readInt(
      db,
      KEYS.intervalMinutes,
      defaults.webdavIntervalMinutes,
      WEBDAV_INTERVAL_MIN,
      WEBDAV_INTERVAL_MAX,
    ),
    webdavKeep: readInt(db, KEYS.keep, defaults.webdavKeep, WEBDAV_KEEP_MIN, WEBDAV_KEEP_MAX),
  };
}

/** 整套落库（不校验；调用方先走 `applyWebdavConfigPatch` 或受信路径）。 */
export function writeServerSettings(db: DatabaseSync, value: ServerSettings): void {
  setMeta(db, KEYS.relayAllowPrivate, value.relayAllowPrivate ? '1' : '0');
  setMeta(db, KEYS.enabled, value.webdavEnabled ? '1' : '0');
  setMeta(db, KEYS.url, value.webdavUrl);
  setMeta(db, KEYS.username, value.webdavUsername);
  setMeta(db, KEYS.password, value.webdavPassword);
  setMeta(db, KEYS.intervalMinutes, String(value.webdavIntervalMinutes));
  setMeta(db, KEYS.keep, String(value.webdavKeep));
}

/** 对外视图（口令只给布尔）。 */
export function serverSettingsView(settings: ServerSettings): ServerSettingsView {
  return {
    relayAllowPrivate: settings.relayAllowPrivate,
    webdavEnabled: settings.webdavEnabled,
    webdavUrl: settings.webdavUrl,
    webdavUsername: settings.webdavUsername,
    webdavPasswordSet: settings.webdavPassword !== '',
    webdavIntervalMinutes: settings.webdavIntervalMinutes,
    webdavKeep: settings.webdavKeep,
  };
}

/** 校验服务器地址：非空且必须 http(s)；合法返回 null，否则返回中文错误。 */
function validateUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '服务器地址格式不正确（需形如 https://dav.example.com/dav/）';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return '服务器地址需以 http:// 或 https:// 开头';
  }
  return null;
}

/** 解析并校验 PUT 请求体；非法时抛 `ServerSettingError`（中文文案）。 */
export function parseWebdavConfigPatch(raw: unknown): WebdavConfigPatch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ServerSettingError('请求内容不正确');
  }
  const record = raw as Record<string, unknown>;
  const patch: WebdavConfigPatch = {};
  if (record.relayAllowPrivate !== undefined) {
    if (typeof record.relayAllowPrivate !== 'boolean') {
      throw new ServerSettingError('「允许转发到内网地址」必须是布尔值');
    }
    patch.relayAllowPrivate = record.relayAllowPrivate;
  }
  if (record.webdavEnabled !== undefined) {
    if (typeof record.webdavEnabled !== 'boolean') {
      throw new ServerSettingError('「自动同步」必须是布尔值');
    }
    patch.webdavEnabled = record.webdavEnabled;
  }
  if (record.webdavUrl !== undefined) {
    if (typeof record.webdavUrl !== 'string') {
      throw new ServerSettingError('「服务器地址」必须是文本');
    }
    patch.webdavUrl = record.webdavUrl.trim();
  }
  if (record.webdavUsername !== undefined) {
    if (typeof record.webdavUsername !== 'string') {
      throw new ServerSettingError('「用户名」必须是文本');
    }
    patch.webdavUsername = record.webdavUsername;
  }
  if (record.webdavPassword !== undefined) {
    if (typeof record.webdavPassword !== 'string') {
      throw new ServerSettingError('「口令」必须是文本');
    }
    patch.webdavPassword = record.webdavPassword;
  }
  if (record.webdavIntervalMinutes !== undefined) {
    const value = record.webdavIntervalMinutes;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < WEBDAV_INTERVAL_MIN ||
      value > WEBDAV_INTERVAL_MAX
    ) {
      throw new ServerSettingError(`同步间隔必须是 ${WEBDAV_INTERVAL_MIN}–${WEBDAV_INTERVAL_MAX} 之间的整数`);
    }
    patch.webdavIntervalMinutes = value;
  }
  if (record.webdavKeep !== undefined) {
    const value = record.webdavKeep;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < WEBDAV_KEEP_MIN ||
      value > WEBDAV_KEEP_MAX
    ) {
      throw new ServerSettingError(`保留份数必须是 ${WEBDAV_KEEP_MIN}–${WEBDAV_KEEP_MAX} 之间的整数`);
    }
    patch.webdavKeep = value;
  }
  if (
    patch.relayAllowPrivate === undefined &&
    patch.webdavEnabled === undefined &&
    patch.webdavUrl === undefined &&
    patch.webdavUsername === undefined &&
    patch.webdavPassword === undefined &&
    patch.webdavIntervalMinutes === undefined &&
    patch.webdavKeep === undefined
  ) {
    throw new ServerSettingError('没有需要更新的配置项');
  }
  return patch;
}

/**
 * 合并校验后的补丁并落库；返回新设置与「哪些字段变了」。
 * 口令：缺省 / 空串 = 不改动；`WEBDAV_PASSWORD_CLEAR` = 清空。返回值绝不含口令明文。
 */
export function applyWebdavConfigPatch(
  db: DatabaseSync,
  config: Config,
  patch: WebdavConfigPatch,
): WebdavConfigUpdateResult {
  const current = readServerSettings(db, config);
  const next: ServerSettings = { ...current };
  const changed: string[] = [];
  const assign = <K extends keyof ServerSettings>(key: K, value: ServerSettings[K]): void => {
    if (current[key] !== value) {
      next[key] = value;
      changed.push(key);
    }
  };

  if (patch.relayAllowPrivate !== undefined) assign('relayAllowPrivate', patch.relayAllowPrivate);
  if (patch.webdavEnabled !== undefined) assign('webdavEnabled', patch.webdavEnabled);
  if (patch.webdavUrl !== undefined) assign('webdavUrl', patch.webdavUrl);
  if (patch.webdavUsername !== undefined) assign('webdavUsername', patch.webdavUsername);
  if (patch.webdavIntervalMinutes !== undefined) assign('webdavIntervalMinutes', patch.webdavIntervalMinutes);
  if (patch.webdavKeep !== undefined) assign('webdavKeep', patch.webdavKeep);

  let passwordChanged = false;
  if (patch.webdavPassword !== undefined && patch.webdavPassword !== '') {
    const nextPassword =
      patch.webdavPassword === WEBDAV_PASSWORD_CLEAR ? '' : patch.webdavPassword;
    passwordChanged = nextPassword !== current.webdavPassword;
    next.webdavPassword = nextPassword;
    if (passwordChanged) changed.push('webdavPassword');
  }

  // 合并后的整体一致性：启用同步前必须有地址；填了地址就必须是 http(s)。
  if (next.webdavEnabled && next.webdavUrl === '') {
    throw new ServerSettingError('启用自动同步前请先填写服务器地址');
  }
  if (next.webdavUrl !== '') {
    const error = validateUrl(next.webdavUrl);
    if (error !== null) throw new ServerSettingError(error);
  }

  writeServerSettings(db, next);
  return { settings: next, changed, passwordChanged };
}
