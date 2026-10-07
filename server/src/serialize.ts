/**
 * 数据校验与归一化（需求 §3 §6）。
 *
 * 形状约定对齐前端 `src/types/reminder.ts`：提醒/标签条目在同步层额外携带
 * `updatedAt`（epoch 毫秒）用于条目级合并；其余字段原样透传，未知字段不丢。
 *
 * 所有函数均为纯函数，便于单测。
 */
import { isValidImageName, MAX_IMAGE_BYTES } from './images.ts';

export type ItemKind = 'reminder' | 'tag';

/** 同步层条目：`id` + `updatedAt` 必需，其余字段原样保留。 */
export interface WireItem {
  id: number;
  updatedAt: number;
  [key: string]: unknown;
}

/**
 * 墓碑（删除标记）。提醒与标签的 id 空间相互独立，因此用 `kind` 区分；
 * 兼容只写 `{id, updatedAt}` 的旧形状（默认按提醒解释）。
 */
export interface WireTombstone {
  id: number;
  updatedAt: number;
  kind: ItemKind;
}

/** 设置信封：整体作为一个可比较更新的条目。 */
export interface SettingsEnvelope {
  value: Record<string, unknown>;
  updatedAt: number;
}

export interface ClientData {
  baseRevision: number;
  reminders: WireItem[];
  tags: WireItem[];
  settings: SettingsEnvelope | null;
  tombstones: WireTombstone[];
  rejected: number;
}

const REMINDER_TYPES = ['ANNUAL', 'COUNT_UP', 'BIRTHDAY'];
const REPEAT_UNITS = ['DAY', 'WEEK', 'MONTH', 'YEAR'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateReminderFields(raw: Record<string, unknown>): boolean {
  if (raw.title !== undefined && typeof raw.title !== 'string') return false;
  if (raw.date !== undefined && typeof raw.date !== 'string') return false;
  if (raw.endDate !== undefined && raw.endDate !== null && typeof raw.endDate !== 'string') return false;
  if (raw.type !== undefined && !(typeof raw.type === 'string' && REMINDER_TYPES.includes(raw.type))) return false;
  if (raw.isLunar !== undefined && typeof raw.isLunar !== 'boolean') return false;
  if (raw.tag !== undefined && typeof raw.tag !== 'string') return false;
  if (raw.isPinned !== undefined && typeof raw.isPinned !== 'boolean') return false;
  if (raw.notes !== undefined && typeof raw.notes !== 'string') return false;
  if (raw.repeatInfo !== undefined && raw.repeatInfo !== null && isRecord(raw.repeatInfo)) {
    const repeat = raw.repeatInfo;
    if (repeat.interval !== undefined && typeof repeat.interval !== 'number') return false;
    if (repeat.unit !== undefined && !(typeof repeat.unit === 'string' && REPEAT_UNITS.includes(repeat.unit))) {
      return false;
    }
  }
  return true;
}

function validateTagFields(raw: Record<string, unknown>): boolean {
  if (raw.name !== undefined && typeof raw.name !== 'string') return false;
  if (raw.color !== undefined && typeof raw.color !== 'string') return false;
  if (raw.sortOrder !== undefined && typeof raw.sortOrder !== 'number') return false;
  return true;
}

/** 解析单个同步条目的可选项。 */
export interface ParseItemOptions {
  /** 是否强制要求 `updatedAt`（API 路径为 true，默认；导入备份包路径为 false）。 */
  requireUpdatedAt?: boolean;
  /** `updatedAt` 缺失且不强制时的补齐值（导入路径传入备份文件 mtime）。 */
  defaultUpdatedAt?: number;
}

/** 解析单个同步条目；无效返回 null（调用方计入 rejected）。 */
export function parseWireItem(raw: unknown, kind: ItemKind, options: ParseItemOptions = {}): WireItem | null {
  if (!isRecord(raw)) return null;
  if (!isPositiveInteger(raw.id)) return null;
  let updatedAt: number;
  if (isTimestamp(raw.updatedAt)) {
    updatedAt = raw.updatedAt;
  } else if (options.requireUpdatedAt === false) {
    updatedAt = isTimestamp(options.defaultUpdatedAt) ? options.defaultUpdatedAt : 0;
  } else {
    return null;
  }
  const validFields = kind === 'reminder' ? validateReminderFields(raw) : validateTagFields(raw);
  if (!validFields) return null;
  return { ...raw, id: raw.id, updatedAt };
}

/** 解析墓碑；无效返回 null。`kind` 缺省按提醒解释。 */
export function parseTombstone(raw: unknown): WireTombstone | null {
  if (!isRecord(raw)) return null;
  if (!isPositiveInteger(raw.id)) return null;
  if (!isTimestamp(raw.updatedAt)) return null;
  let kind: ItemKind = 'reminder';
  if (raw.kind !== undefined) {
    if (raw.kind !== 'reminder' && raw.kind !== 'tag') return null;
    kind = raw.kind;
  }
  return { id: raw.id, updatedAt: raw.updatedAt, kind };
}

/** 解析设置信封；无效返回 null。 */
export function parseSettingsEnvelope(raw: unknown): SettingsEnvelope | null {
  if (!isRecord(raw)) return null;
  if (!isTimestamp(raw.updatedAt)) return null;
  if (!isRecord(raw.value)) return null;
  return { value: { ...raw.value }, updatedAt: raw.updatedAt };
}

/**
 * 解析条目列表。默认要求每条携带 `updatedAt`（`PUT /api/data` API 路径）；
 * 导入安卓备份包时传 `{ requireUpdatedAt: false, defaultUpdatedAt }`，接受缺省条目
 * （`id` 必需；`updatedAt` 由导入路径用备份文件 mtime 补齐）。
 */
export function parseItemList(
  raw: unknown,
  kind: ItemKind,
  rejected: { count: number },
  options: ParseItemOptions = {},
): WireItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    rejected.count += 1;
    return [];
  }
  const out: WireItem[] = [];
  for (const entry of raw) {
    const item = parseWireItem(entry, kind, options);
    if (item === null) rejected.count += 1;
    else out.push(item);
  }
  return out;
}

function parseTombstoneList(raw: unknown, rejected: { count: number }): WireTombstone[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    rejected.count += 1;
    return [];
  }
  const out: WireTombstone[] = [];
  for (const entry of raw) {
    const item = parseTombstone(entry);
    if (item === null) rejected.count += 1;
    else out.push(item);
  }
  return out;
}

/**
 * 解析 `PUT /api/data` 请求体。
 * 数组缺省视为空，非数组/坏条目计入 `rejected`；`baseRevision` 非数字回落 0。
 */
export function parseClientData(raw: unknown): ClientData {
  if (!isRecord(raw)) {
    return { baseRevision: 0, reminders: [], tags: [], settings: null, tombstones: [], rejected: 1 };
  }
  const rejected = { count: 0 };
  const baseRevision =
    typeof raw.baseRevision === 'number' && Number.isFinite(raw.baseRevision) && raw.baseRevision >= 0
      ? Math.floor(raw.baseRevision)
      : 0;
  const settings = raw.settings === undefined || raw.settings === null ? null : parseSettingsEnvelope(raw.settings);
  if (raw.settings !== undefined && raw.settings !== null && settings === null) rejected.count += 1;
  return {
    baseRevision,
    reminders: parseItemList(raw.reminders, 'reminder', rejected),
    tags: parseItemList(raw.tags, 'tag', rejected),
    settings,
    tombstones: parseTombstoneList(raw.tombstones, rejected),
    rejected: rejected.count,
  };
}

/** 整库替换请求体里的图片条目（base64 传输）。 */
export interface ReplaceImage {
  name: string;
  bytes: Uint8Array;
}

/** `PUT /api/data/replace` 的解析结果。 */
export interface ReplaceData {
  reminders: WireItem[];
  tags: WireItem[];
  settings: SettingsEnvelope;
  images: ReplaceImage[];
  /** 因形状非法被丢弃的条目 / 图片数。 */
  rejected: number;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    // Buffer 的 base64 解码容忍空白；非法字符会被忽略，因此额外做长度合理性检查。
    return new Uint8Array(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

function parseReplaceImages(raw: unknown, rejected: { count: number }): ReplaceImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    rejected.count += 1;
    return [];
  }
  const out: ReplaceImage[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.data !== 'string') {
      rejected.count += 1;
      continue;
    }
    if (!isValidImageName(entry.name)) {
      rejected.count += 1;
      continue;
    }
    const bytes = decodeBase64(entry.data);
    if (bytes === null || bytes.length > MAX_IMAGE_BYTES) {
      rejected.count += 1;
      continue;
    }
    out.push({ name: entry.name, bytes });
  }
  return out;
}

/**
 * 解析 `PUT /api/data/replace` 请求体（整库覆盖，M11 §2）。
 * 与 `parseClientData` 分离：这里不做增量合并语义，条目要求 `updatedAt`，
 * `settings` 缺省视为空信封（整体替换后即为空设置）。
 */
export function parseReplaceData(raw: unknown): ReplaceData {
  if (!isRecord(raw)) {
    return { reminders: [], tags: [], settings: { value: {}, updatedAt: 0 }, images: [], rejected: 1 };
  }
  const rejected = { count: 0 };
  const settings = raw.settings === undefined || raw.settings === null ? { value: {}, updatedAt: 0 } : parseSettingsEnvelope(raw.settings);
  if (settings === null) {
    rejected.count += 1;
  }
  return {
    reminders: parseItemList(raw.reminders, 'reminder', rejected),
    tags: parseItemList(raw.tags, 'tag', rejected),
    settings: settings ?? { value: {}, updatedAt: 0 },
    images: parseReplaceImages(raw.images, rejected),
    rejected: rejected.count,
  };
}

/**
 * 归一化为持久化用的 JSON 对象：保留全部字段（未知字段不丢）。
 */
export function toStorageItem(item: WireItem): Record<string, unknown> {
  return { ...item, id: item.id, updatedAt: item.updatedAt };
}

/** 从数据库行（payload + updated_at）还原同步条目。 */
export function fromStorageItem(id: number, updatedAt: number, payload: unknown): WireItem {
  const base = isRecord(payload) ? payload : {};
  return { ...base, id, updatedAt };
}
