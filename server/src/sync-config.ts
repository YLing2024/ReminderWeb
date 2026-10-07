/**
 * 同步配置（M9 §1）——**兼容视图**。
 *
 * 自动同步开关 / 间隔 / 保留份数统一存在 `server-settings.ts` 的库里
 * （与页面上可编辑的 WebDAV 设置同一套键）。本模块只保留旧接口的
 * 视图形状与校验语义（间隔白名单 5/10/30/60、保留份数 1–50），
 * 供 `GET/PUT /api/sync/config` 与 `SyncEngine.updateConfig` 继续使用，
 * 不再自己维护第二套存储。
 *
 * 凭据（URL / 用户名 / 口令）由 `server-settings.ts` 持有，绝不在这里出现。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { readServerSettings, writeServerSettings } from './server-settings.ts';

/** 允许的同步间隔（分钟）。 */
export const SYNC_INTERVALS: readonly number[] = [5, 10, 30, 60];
/** 保留份数范围（份）。 */
export const SYNC_KEEP_MIN = 1;
export const SYNC_KEEP_MAX = 50;

const DEFAULT_INTERVAL = 10;
const DEFAULT_KEEP = 10;

export interface StoredSyncConfig {
  enabled: boolean;
  intervalMinutes: number;
  keep: number;
}

export interface SyncConfigPatch {
  enabled?: boolean;
  intervalMinutes?: number;
  keep?: number;
}

export interface SyncConfigView extends StoredSyncConfig {
  options: { intervals: number[]; keepRange: [number, number] };
  /** 只包含目录地址（不含凭据）；未启用时为空串。 */
  url: string;
}

/** 非法配置：`message` 为可直接展示的中文文案。 */
export class SyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncConfigError';
  }
}

/** 把任意数值规范到允许的间隔；不在白名单内回落 10。 */
export function normalizeInterval(value: number): number {
  return SYNC_INTERVALS.includes(value) ? value : DEFAULT_INTERVAL;
}

/** 把任意数值规范到 1..50 的整数。 */
export function normalizeKeep(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_KEEP;
  return Math.min(SYNC_KEEP_MAX, Math.max(SYNC_KEEP_MIN, Math.trunc(value)));
}

/** 读取同步配置（来自统一设置；兼容视图不做范围夹取，合法校验在写入侧）。 */
export function readSyncConfig(db: DatabaseSync, config: Config): StoredSyncConfig {
  const settings = readServerSettings(db, config);
  return {
    enabled: settings.webdavEnabled,
    intervalMinutes: settings.webdavIntervalMinutes,
    keep: settings.webdavKeep,
  };
}

/** 写回同步配置（三项一起写，落到统一设置）。 */
export function writeSyncConfig(db: DatabaseSync, config: Config, value: StoredSyncConfig): void {
  const settings = readServerSettings(db, config);
  writeServerSettings(db, {
    ...settings,
    webdavEnabled: value.enabled,
    webdavIntervalMinutes: value.intervalMinutes,
    webdavKeep: value.keep,
  });
}

/** 构造对外的配置视图（含可选项；`url` 未启用时为空串）。 */
export function syncConfigView(stored: StoredSyncConfig, url: string): SyncConfigView {
  return {
    enabled: stored.enabled,
    intervalMinutes: stored.intervalMinutes,
    keep: stored.keep,
    options: { intervals: [...SYNC_INTERVALS], keepRange: [SYNC_KEEP_MIN, SYNC_KEEP_MAX] },
    url: stored.enabled ? url : '',
  };
}

/** 解析并校验 PUT 请求体；非法时抛 `SyncConfigError`（中文文案）。 */
export function parseSyncConfigPatch(raw: unknown): SyncConfigPatch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SyncConfigError('请求内容不正确');
  }
  const record = raw as Record<string, unknown>;
  const patch: SyncConfigPatch = {};
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') throw new SyncConfigError('自动同步开关必须是布尔值');
    patch.enabled = record.enabled;
  }
  if (record.intervalMinutes !== undefined) {
    if (typeof record.intervalMinutes !== 'number' || !SYNC_INTERVALS.includes(record.intervalMinutes)) {
      throw new SyncConfigError('同步间隔只能选择 5 / 10 / 30 / 60 分钟');
    }
    patch.intervalMinutes = record.intervalMinutes;
  }
  if (record.keep !== undefined) {
    if (
      typeof record.keep !== 'number' ||
      !Number.isInteger(record.keep) ||
      record.keep < SYNC_KEEP_MIN ||
      record.keep > SYNC_KEEP_MAX
    ) {
      throw new SyncConfigError(`保留份数必须是 ${SYNC_KEEP_MIN}–${SYNC_KEEP_MAX} 之间的整数`);
    }
    patch.keep = record.keep;
  }
  if (patch.enabled === undefined && patch.intervalMinutes === undefined && patch.keep === undefined) {
    throw new SyncConfigError('没有需要更新的配置项');
  }
  return patch;
}

/** 合并校验后的补丁并落库，返回新配置。 */
export function applySyncConfigPatch(
  db: DatabaseSync,
  config: Config,
  patch: SyncConfigPatch,
): StoredSyncConfig {
  const current = readSyncConfig(db, config);
  const next: StoredSyncConfig = {
    enabled: patch.enabled ?? current.enabled,
    intervalMinutes: patch.intervalMinutes ?? current.intervalMinutes,
    keep: patch.keep ?? current.keep,
  };
  writeSyncConfig(db, config, next);
  return next;
}
