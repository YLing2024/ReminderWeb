/**
 * 业务数据层（需求 §6）：读取、条目级合并、写入。
 *
 * 合并规则（纯函数 `mergeData`，可单测）：
 * - 提醒 / 标签按 `id` 对齐，两侧同 id 时取 `updatedAt` 大者；
 * - 相同 `updatedAt` 时以服务端现状为准（保证幂等）；
 * - 墓碑优先级高于普通条目：`updatedAt` 相同时墓碑胜出；
 * - 客户端无效条目已在解析阶段丢弃并计入 `rejected`；
 * - 客户端「未提及」的服务端条目原样保留（不做隐式删除）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { bumpRevision, getRevision } from './db.ts';
import {
  fromStorageItem,
  toStorageItem,
  type SettingsEnvelope,
  type WireItem,
  type WireTombstone,
} from './serialize.ts';

export interface ServerData {
  reminders: WireItem[];
  tags: WireItem[];
  settings: SettingsEnvelope;
  /** 提醒与标签的墓碑（带 kind 区分）。 */
  tombstones: WireTombstone[];
}

export interface MergeInput {
  reminders: WireItem[];
  tags: WireItem[];
  settings: SettingsEnvelope | null;
  tombstones: WireTombstone[];
}

export interface MergeOutcome {
  reminders: WireItem[];
  tags: WireItem[];
  settings: SettingsEnvelope;
  tombstones: WireTombstone[];
  /** 本次合并是否改动了服务端状态（决定 revision 是否自增）。 */
  changed: boolean;
}

interface Row {
  id: number;
  updatedAt: number;
  deleted: boolean;
  payload: Record<string, unknown> | null;
}

const EMPTY_SETTINGS: SettingsEnvelope = { value: {}, updatedAt: 0 };

function buildMap(items: WireItem[], tombstones: WireTombstone[]): Map<number, Row> {
  const map = new Map<number, Row>();
  for (const item of items) {
    map.set(item.id, { id: item.id, updatedAt: item.updatedAt, deleted: false, payload: toStorageItem(item) });
  }
  for (const tomb of tombstones) {
    const existing = map.get(tomb.id);
    if (existing === undefined) {
      map.set(tomb.id, { id: tomb.id, updatedAt: tomb.updatedAt, deleted: true, payload: null });
    } else if (tomb.updatedAt >= existing.updatedAt) {
      // 相同 updatedAt 时墓碑胜出。
      existing.deleted = true;
      existing.updatedAt = tomb.updatedAt;
    }
  }
  return map;
}

function applyItems(map: Map<number, Row>, items: WireItem[]): void {
  for (const item of items) {
    const existing = map.get(item.id);
    if (existing === undefined || item.updatedAt > existing.updatedAt) {
      map.set(item.id, { id: item.id, updatedAt: item.updatedAt, deleted: false, payload: toStorageItem(item) });
    }
    // 相同或更旧：以服务端现状为准（幂等）。
  }
}

function applyTombstones(map: Map<number, Row>, tombstones: WireTombstone[]): void {
  for (const tomb of tombstones) {
    const existing = map.get(tomb.id);
    if (existing === undefined) {
      map.set(tomb.id, { id: tomb.id, updatedAt: tomb.updatedAt, deleted: true, payload: null });
      continue;
    }
    if (tomb.updatedAt > existing.updatedAt || (tomb.updatedAt === existing.updatedAt && !existing.deleted)) {
      existing.deleted = true;
      existing.updatedAt = tomb.updatedAt;
    }
  }
}

function snapshot(map: Map<number, Row>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [id, row] of map) out.set(id, `${row.updatedAt}:${row.deleted ? 1 : 0}`);
  return out;
}

function snapshotsEqual(a: Map<number, string>, b: Map<number, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, signature] of a) {
    if (b.get(id) !== signature) return false;
  }
  return true;
}

function collect(map: Map<number, Row>, kind: WireTombstone['kind']): { items: WireItem[]; tombstones: WireTombstone[] } {
  const items: WireItem[] = [];
  const tombstones: WireTombstone[] = [];
  for (const row of map.values()) {
    if (row.deleted) {
      tombstones.push({ id: row.id, updatedAt: row.updatedAt, kind });
    } else {
      items.push(fromStorageItem(row.id, row.updatedAt, row.payload));
    }
  }
  items.sort((x, y) => x.id - y.id);
  tombstones.sort((x, y) => x.id - y.id);
  return { items, tombstones };
}

/** 条目级合并纯函数。 */
export function mergeData(server: ServerData, client: MergeInput): MergeOutcome {
  const reminderTombstones = server.tombstones.filter((t) => t.kind === 'reminder');
  const tagTombstones = server.tombstones.filter((t) => t.kind === 'tag');

  const reminderMap = buildMap(server.reminders, reminderTombstones);
  const tagMap = buildMap(server.tags, tagTombstones);
  const beforeReminders = snapshot(reminderMap);
  const beforeTags = snapshot(tagMap);

  applyItems(
    reminderMap,
    client.reminders,
  );
  applyTombstones(
    reminderMap,
    client.tombstones.filter((t) => t.kind === 'reminder'),
  );
  applyItems(tagMap, client.tags);
  applyTombstones(
    tagMap,
    client.tombstones.filter((t) => t.kind === 'tag'),
  );

  const clientSettingsWins = client.settings !== null && client.settings.updatedAt > server.settings.updatedAt;
  const settings = clientSettingsWins && client.settings !== null ? client.settings : server.settings;

  const changed =
    !snapshotsEqual(snapshot(reminderMap), beforeReminders) ||
    !snapshotsEqual(snapshot(tagMap), beforeTags) ||
    clientSettingsWins;

  const reminders = collect(reminderMap, 'reminder');
  const tags = collect(tagMap, 'tag');
  return {
    reminders: reminders.items,
    tags: tags.items,
    settings,
    tombstones: [...reminders.tombstones, ...tags.tombstones],
    changed,
  };
}

/* ------------------------------------------------------------------ */
/* 数据库读写                                                          */
/* ------------------------------------------------------------------ */

interface RowRecord {
  id: number;
  payload: string;
  updatedAt: number;
  deleted: number;
}

function readKind(
  db: DatabaseSync,
  table: 'reminders' | 'tags',
): { items: WireItem[]; tombstones: WireTombstone[] } {
  const rows = db
    .prepare(`SELECT id, payload, updated_at AS updatedAt, deleted FROM ${table} ORDER BY id ASC`)
    .all() as RowRecord[];
  const items: WireItem[] = [];
  const tombstones: WireTombstone[] = [];
  const kind = table === 'reminders' ? 'reminder' : 'tag';
  for (const row of rows) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = null;
    }
    if (row.deleted === 1) {
      tombstones.push({ id: row.id, updatedAt: row.updatedAt, kind });
    } else {
      items.push(fromStorageItem(row.id, row.updatedAt, payload));
    }
  }
  return { items, tombstones };
}

/** 读取服务端当前完整状态。 */
export function readServerData(db: DatabaseSync): ServerData {
  const reminderData = readKind(db, 'reminders');
  const tagData = readKind(db, 'tags');
  const settingsRow = db.prepare('SELECT payload, updated_at FROM settings WHERE k = ?').get('app') as
    | { payload: string; updated_at: number }
    | undefined;
  let settings: SettingsEnvelope = { ...EMPTY_SETTINGS };
  if (settingsRow !== undefined) {
    try {
      const parsed: unknown = JSON.parse(settingsRow.payload);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const value = record.value;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          settings = { value: value as Record<string, unknown>, updatedAt: settingsRow.updated_at };
        }
      }
    } catch {
      settings = { ...EMPTY_SETTINGS };
    }
  }
  return {
    reminders: reminderData.items,
    tags: tagData.items,
    settings,
    tombstones: [...reminderData.tombstones, ...tagData.tombstones],
  };
}

/** 当前 revision。 */
export function readRevision(db: DatabaseSync): number {
  return getRevision(db);
}

function upsertKind(db: DatabaseSync, table: 'reminders' | 'tags', outcome: MergeOutcome, kind: 'reminder' | 'tag'): void {
  const items = kind === 'reminder' ? outcome.reminders : outcome.tags;
  const tombstones = outcome.tombstones.filter((t) => t.kind === kind);
  const stmt = db.prepare(
    `INSERT INTO ${table} (id, payload, updated_at, deleted) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, deleted = excluded.deleted`,
  );
  for (const item of items) {
    stmt.run(item.id, JSON.stringify(toStorageItem(item)), item.updatedAt, 0);
  }
  for (const tomb of tombstones) {
    stmt.run(tomb.id, JSON.stringify({ id: tomb.id, updatedAt: tomb.updatedAt }), tomb.updatedAt, 1);
  }
}

/**
 * 把合并结果落库；有改动时 revision 自增一次，返回新的 revision。
 * 整个写入在一个事务里完成。
 */
export function writeMergedData(db: DatabaseSync, outcome: MergeOutcome): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    upsertKind(db, 'reminders', outcome, 'reminder');
    upsertKind(db, 'tags', outcome, 'tag');
    db.prepare(
      'INSERT INTO settings (k, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
    ).run('app', JSON.stringify(outcome.settings), outcome.settings.updatedAt);
    const revision = outcome.changed ? bumpRevision(db) : getRevision(db);
    db.exec('COMMIT');
    return revision;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
