/**
 * 备份包格式（与安卓版 / 前端逐字互通，M7 §3）。
 *
 * - 文件名：`reminder-backup-yyyyMMdd-HHmmss.zip`（不得改名）。
 * - 内容：`metadata.json`（`BackupData` 形状）+ 有图片时的 `images/`。
 * - 可选加密：见 `backup-crypto.ts`（AES-256-CBC + PKCS7，密钥 = SHA-256(常量逐字节 XOR 90)）。
 * - 条目形状映射走共享模块 `src/lib/android-shape.ts`（前端与后端同一份）。
 *
 * 合成/解析均为纯函数，可直接单测。
 */
import type { BackupData, ReminderItem, TagItem } from '../../src/types/reminder.ts';
import { fromAndroidReminderList, fromAndroidTagList, stripSyncMeta } from '../../src/lib/android-shape.ts';
import { decryptArchive, encryptArchive, isZip } from './backup-crypto.ts';
import type { ServerData } from './data.ts';
import type { SettingsEnvelope, WireItem } from './serialize.ts';
import { zipCreate, zipExtract } from './zip.ts';

export const BACKUP_EXTENSION = '.zip';
export const METADATA_ENTRY = 'metadata.json';
export const IMAGES_DIR = 'images/';

/** 备份包解析/解密失败时抛出，`message` 为可直接展示的中文文案。 */
export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

export interface ArchiveInput {
  metadataJson: string;
  images?: Record<string, Uint8Array>;
}

export interface ArchiveContent {
  metadataJson: string;
  images: Record<string, Uint8Array>;
}

function basename(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? name;
}

/** 打包归档；`encrypt=true` 时整包加密。 */
export function encodeArchive(input: ArchiveInput, encrypt: boolean): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  files[METADATA_ENTRY] = new TextEncoder().encode(input.metadataJson);
  for (const [name, bytes] of Object.entries(input.images ?? {})) {
    if (name.trim() === '') continue;
    files[IMAGES_DIR + basename(name)] = bytes;
  }
  const zip = zipCreate(files);
  return encrypt ? encryptArchive(zip) : zip;
}

/** 解析归档：优先按明文 zip，否则尝试解密（与前端/安卓一致）。 */
export function decodeArchive(data: Uint8Array): ArchiveContent {
  let zipBytes: Uint8Array;
  if (isZip(data)) {
    zipBytes = data;
  } else {
    const decrypted = decryptArchive(data);
    if (decrypted === null) {
      throw new BackupFormatError('无法识别该备份包：既不是有效的 zip，也无法用上游密钥解密。');
    }
    if (!isZip(decrypted)) {
      throw new BackupFormatError('解密结果不是有效的备份 zip。');
    }
    zipBytes = decrypted;
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = zipExtract(zipBytes);
  } catch {
    throw new BackupFormatError('备份包已损坏，无法解压。');
  }
  const metadataBytes = entries[METADATA_ENTRY];
  if (metadataBytes === undefined) {
    throw new BackupFormatError('备份包缺少 metadata.json。');
  }
  const images: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith(IMAGES_DIR)) images[basename(name)] = bytes;
  }
  return { metadataJson: new TextDecoder().decode(metadataBytes), images };
}

/** 备份文件名（与安卓 / 前端一致）。 */
export function backupFileName(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  const stamp =
    `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `reminder-backup-${stamp}${BACKUP_EXTENSION}`;
}

/** 备份包中参与服务器同步的设置字段（与前端 BackupData 同名）。 */
const SETTING_KEYS = [
  'themeOption',
  'pureBlackEnabled',
  'cardColoringEnabled',
  'defaultPage',
  'viewMode',
  'backupReminderEnabled',
  'dynamicColorEnabled',
  'themeColorPalette',
  'customColorSeed',
  'scrollBehavior',
  'homeCategoryEnabled',
] as const;

export interface ParsedBackup {
  reminders: WireItem[];
  tags: WireItem[];
  settings: SettingsEnvelope | null;
  /** 因 id 非法而丢弃的条目数。 */
  rejected: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析备份 metadata.json，转换为可合并的同步条目。
 * `updatedAt` 由调用方传入（同批同值，来自备份文件 mtime），保证合并幂等。
 */
export function parseBackupMetadata(metadataJson: string, updatedAt: number): ParsedBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    throw new BackupFormatError('metadata.json 不是合法 JSON。');
  }
  if (!isRecord(parsed)) {
    throw new BackupFormatError('metadata.json 结构不正确。');
  }
  if (!Array.isArray(parsed.reminders)) {
    throw new BackupFormatError('metadata.json 缺少 reminders 列表。');
  }
  const rawReminders = parsed.reminders;
  const reminders = fromAndroidReminderList(rawReminders, updatedAt)
    .filter((item) => Number.isInteger(item.id) && item.id > 0)
    .map((item) => ({ ...item, id: item.id, updatedAt }) as WireItem);
  const rawTags = Array.isArray(parsed.tags) ? parsed.tags : [];
  const tags = fromAndroidTagList(rawTags, updatedAt)
    .filter((tag) => Number.isInteger(tag.id) && tag.id > 0)
    .map((tag) => ({ ...tag, id: tag.id, updatedAt }) as WireItem);

  const value: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const entry = parsed[key];
    if (entry !== null && entry !== undefined) value[key] = entry;
  }
  const settings = Object.keys(value).length > 0 ? { value, updatedAt } : null;
  const rejected = rawReminders.length - reminders.length + (rawTags.length - tags.length);
  return { reminders, tags, settings, rejected };
}

/** 由服务端当前状态构造 BackupData（未内联图片，条目不含同步元数据）。 */
export function buildBackupData(server: ServerData): BackupData {
  const settings = server.settings.value;
  const pick = (key: string): unknown => (key in settings ? settings[key] : null);
  return {
    reminders: server.reminders.map((item) => stripSyncMeta(item) as unknown as ReminderItem),
    tags: server.tags.map((tag) => stripSyncMeta(tag) as unknown as TagItem),
    themeOption: pick('themeOption') as BackupData['themeOption'],
    pureBlackEnabled: pick('pureBlackEnabled') as boolean | null,
    cardColoringEnabled: pick('cardColoringEnabled') as boolean | null,
    defaultPage: pick('defaultPage') as BackupData['defaultPage'],
    viewMode: (pick('viewMode') as string | null) ?? null,
    backupReminderEnabled: pick('backupReminderEnabled') as boolean | null,
    webDavServer: null,
    webDavUsername: null,
    webDavPassword: null,
    webDavPath: null,
    dynamicColorEnabled: pick('dynamicColorEnabled') as boolean | null,
    themeColorPalette: pick('themeColorPalette') as BackupData['themeColorPalette'],
    customColorSeed: pick('customColorSeed') as number | null,
    scrollBehavior: (pick('scrollBehavior') as string | null) ?? null,
    homeCategoryEnabled: pick('homeCategoryEnabled') as boolean | null,
    cardBackgroundImages: null,
  };
}

/** 由服务端当前状态构造 metadata.json 字符串。 */
export function buildBackupMetadata(server: ServerData): string {
  return JSON.stringify(buildBackupData(server));
}
