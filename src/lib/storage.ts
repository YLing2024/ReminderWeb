/**
 * IndexedDB 持久化（idb-keyval）。
 *
 * 存放约定（需求 §3）：
 * - 结构化数据一份存 key `reminderweb:data`；
 * - 图片按文件名存 `reminderweb:image:<name>`，与安卓 zip 内 `images/<name>` 引用一致。
 */
import { createStore, del, get, keys, set, clear } from 'idb-keyval';
import type { ReminderItem, TagItem } from '../types/reminder';

export const DATA_KEY = 'reminderweb:data';
export const IMAGE_KEY_PREFIX = 'reminderweb:image:';
export const FONT_KEY_PREFIX = 'reminderweb:font:';

/** Web 端本地设置（与安卓 Settings 对齐的子集，M2 起使用）。 */
export interface AppSettings {
  themeOption: 'SYSTEM' | 'LIGHT' | 'DARK';
  pureBlackEnabled: boolean;
  cardColoringEnabled: boolean;
  homeCategoryEnabled: boolean;
  defaultPage: 'COUNTDOWN' | 'COUNTUP' | 'BIRTHDAY';
  viewMode: string;
  scrollBehavior: string;
  dynamicColorEnabled: boolean;
  themeColorPalette: string;
  customColorSeed: number | null;
  /** 提醒：是否启用应用内通知（Web Notification 权限）。 */
  notificationEnabled: boolean;
  /** 提醒：默认提前天数。 */
  defaultAdvanceDays: number;
  /** 提醒：提醒方式（应用内通知 / 导出 .ics）。 */
  reminderMethod: 'APP_NOTIFICATION' | 'ICS';
  /** 数据：备份提醒开关。 */
  backupReminderEnabled: boolean;
  /** 数据：导出备份时是否启用「加密（兼容安卓）」。 */
  backupEncryptionEnabled: boolean;
  /** 数据：上次备份时间（epoch 毫秒），从未备份为 null。 */
  lastBackupAt: number | null;
  /** 安全：应用锁开关。 */
  appLockEnabled: boolean;
  /** 安全：应用锁 PIN 的 SHA-256 十六进制摘要。 */
  appLockPinHash: string | null;
}

export interface PersistedData {
  reminders: ReminderItem[];
  tags: TagItem[];
  settings: AppSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  themeOption: 'SYSTEM',
  pureBlackEnabled: false,
  cardColoringEnabled: true,
  homeCategoryEnabled: true,
  defaultPage: 'COUNTDOWN',
  viewMode: 'CARD',
  scrollBehavior: 'HIDE_BOTTOM_BAR',
  dynamicColorEnabled: true,
  themeColorPalette: 'PURPLE',
  customColorSeed: null,
  notificationEnabled: false,
  defaultAdvanceDays: 0,
  reminderMethod: 'APP_NOTIFICATION',
  backupReminderEnabled: false,
  backupEncryptionEnabled: true,
  lastBackupAt: null,
  appLockEnabled: false,
  appLockPinHash: null,
};

const store = createStore('reminderweb', 'kv');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function loadPersistedData(): Promise<PersistedData> {
  const raw: unknown = await get(DATA_KEY, store);
  if (!isRecord(raw)) {
    return { reminders: [], tags: [], settings: { ...DEFAULT_SETTINGS } };
  }
  const reminders = Array.isArray(raw.reminders) ? (raw.reminders as ReminderItem[]) : [];
  const tags = Array.isArray(raw.tags) ? (raw.tags as TagItem[]) : [];
  const settings = isRecord(raw.settings)
    ? { ...DEFAULT_SETTINGS, ...(raw.settings as Partial<AppSettings>) }
    : { ...DEFAULT_SETTINGS };
  return { reminders, tags, settings };
}

export async function savePersistedData(data: PersistedData): Promise<void> {
  await set(DATA_KEY, data, store);
}

/** 清空本地全部数据（结构化数据与图片）。 */
export async function clearAllData(): Promise<void> {
  await clear(store);
}

export function imageKey(name: string): string {
  return `${IMAGE_KEY_PREFIX}${name}`;
}

export async function saveImageBlob(name: string, blob: Blob): Promise<void> {
  await set(imageKey(name), blob, store);
}

export async function loadImageBlob(name: string): Promise<Blob | undefined> {
  return get<Blob>(imageKey(name), store);
}

export async function deleteImageBlob(name: string): Promise<void> {
  await del(imageKey(name), store);
}

export async function listImageNames(): Promise<string[]> {
  const all = await keys<string>(store);
  return all
    .filter((key) => typeof key === 'string' && key.startsWith(IMAGE_KEY_PREFIX))
    .map((key) => key.slice(IMAGE_KEY_PREFIX.length));
}

/** 用给定图片集合替换本地图片库：未出现在集合中的旧图片会被删除。 */
export async function replaceImageBlobs(images: Record<string, Blob>): Promise<void> {
  const existing = await listImageNames();
  for (const name of existing) {
    if (!Object.prototype.hasOwnProperty.call(images, name)) {
      await del(imageKey(name), store);
    }
  }
  for (const [name, blob] of Object.entries(images)) {
    await set(imageKey(name), blob, store);
  }
}

export function fontKey(name: string): string {
  return `${FONT_KEY_PREFIX}${name}`;
}

export async function listFontNames(): Promise<string[]> {
  const all = await keys<string>(store);
  return all
    .filter((key) => typeof key === 'string' && key.startsWith(FONT_KEY_PREFIX))
    .map((key) => key.slice(FONT_KEY_PREFIX.length));
}

export async function loadFontBlob(name: string): Promise<Blob | undefined> {
  return get<Blob>(fontKey(name), store);
}

/** 用给定字体集合替换本地字体库：未出现在集合中的旧字体会被删除。 */
export async function replaceFontBlobs(fonts: Record<string, Blob>): Promise<void> {
  const existing = await listFontNames();
  for (const name of existing) {
    if (!Object.prototype.hasOwnProperty.call(fonts, name)) {
      await del(fontKey(name), store);
    }
  }
  for (const [name, blob] of Object.entries(fonts)) {
    await set(fontKey(name), blob, store);
  }
}
