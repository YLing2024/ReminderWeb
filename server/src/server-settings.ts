/**
 * 服务器级通用设置（M12 §3.1）。
 *
 * 「允许转发到内网地址」（`relayAllowPrivate`）存在 SQLite 的 `meta` 表里，对所有设备一致。
 * 环境变量 `WEBDAV_RELAY_ALLOW_PRIVATE` 退化为**首次默认值**：首次读取（meta 里还没有该项）
 * 时按 env 落库，之后一律以库里的值为准；用户在界面改过就保持，重启不丢。
 *
 * 这是客户端模式 WebDAV 转发（`/api/webdav/*`）的 SSRF 放行开关：
 * 关闭时拒绝回环 / 内网 / 链路本地 / 云元数据地址；只有 WebDAV 装在局域网才应打开。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { getMeta, setMeta } from './db.ts';

const KEY = 'relayAllowPrivate';

export interface RelayConfigView {
  relayAllowPrivate: boolean;
}

/** 非法设置：`message` 为可直接展示的中文文案。 */
export class ServerSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerSettingError';
  }
}

/** 读取是否放行内网目标；首次读取时按环境变量默认值落库。 */
export function readRelayAllowPrivate(db: DatabaseSync, config: Config): boolean {
  const raw = getMeta(db, KEY);
  if (raw !== undefined) return raw === '1';
  const seeded = config.webdavRelayAllowPrivate;
  setMeta(db, KEY, seeded ? '1' : '0');
  return seeded;
}

export function writeRelayAllowPrivate(db: DatabaseSync, value: boolean): void {
  setMeta(db, KEY, value ? '1' : '0');
}

export function relayConfigView(db: DatabaseSync, config: Config): RelayConfigView {
  return { relayAllowPrivate: readRelayAllowPrivate(db, config) };
}

/** 解析并校验 PUT 请求体；非法时抛 `ServerSettingError`（中文文案）。 */
export function parseRelayConfigPatch(raw: unknown): RelayConfigView {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ServerSettingError('请求内容不正确');
  }
  const value = (raw as Record<string, unknown>).relayAllowPrivate;
  if (typeof value !== 'boolean') {
    throw new ServerSettingError('「允许转发到内网地址」必须是布尔值');
  }
  return { relayAllowPrivate: value };
}

/** 合并校验后的补丁并落库，返回新设置。 */
export function applyRelayConfigPatch(db: DatabaseSync, patch: RelayConfigView): RelayConfigView {
  writeRelayAllowPrivate(db, patch.relayAllowPrivate);
  return { relayAllowPrivate: patch.relayAllowPrivate };
}
