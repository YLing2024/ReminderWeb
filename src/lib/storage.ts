/**
 * IndexedDB 持久化（idb-keyval）。
 *
 * 存放约定（需求 §3）：
 * - 结构化数据一份存 key `reminderweb:data`；
 * - 图片按文件名存 `reminderweb:image:<name>`，与安卓 zip 内 `images/<name>` 引用一致。
 */
import { createStore, del, get, keys, set } from 'idb-keyval';
import type { ReminderItem, TagItem } from '../types/reminder';

export const DATA_KEY = 'reminderweb:data';
export const IMAGE_KEY_PREFIX = 'reminderweb:image:';

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
  scrollBehavior: 'AUTO_HIDE',
  dynamicColorEnabled: true,
  themeColorPalette: 'PURPLE',
  customColorSeed: null,
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
