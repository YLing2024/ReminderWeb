/**
 * SQLite 打开与建表迁移（需求 §6.1）。
 *
 * 使用 `node:sqlite` 的 `DatabaseSync`（同步 API，无需第三方驱动）。
 * - `PRAGMA journal_mode=WAL`：并发读写更稳；
 * - `PRAGMA foreign_keys=ON`、`busy_timeout=5000`；
 * - `meta` 保存 `schema_version` 与 `revision`。
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;
export const DB_FILE_NAME = 'reminder.db';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tags      (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings  (k TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS images    (name TEXT PRIMARY KEY, bytes BLOB NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions  (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users     (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit     (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
`;

function configure(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA busy_timeout=5000;');
}

function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
  const insertMeta = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
  insertMeta.run('schema_version', String(SCHEMA_VERSION));
  insertMeta.run('revision', '0');
}

/** 打开位于数据目录下的 SQLite 数据库（自动建目录、建表、设 PRAGMA）。 */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  return openDatabaseAt(join(dataDir, DB_FILE_NAME));
}

/** 打开指定路径的数据库；`:memory:` 用于测试。 */
export function openDatabaseAt(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  configure(db);
  migrate(db);
  return db;
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: unknown } | undefined;
  if (row === undefined || typeof row.value !== 'string') return undefined;
  return row.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function getRevision(db: DatabaseSync): number {
  const raw = getMeta(db, 'revision');
  const value = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** revision 自增并返回新值。 */
export function bumpRevision(db: DatabaseSync): number {
  const next = getRevision(db) + 1;
  setMeta(db, 'revision', String(next));
  return next;
}

export function getSchemaVersion(db: DatabaseSync): number {
  const raw = getMeta(db, 'schema_version');
  const value = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/** 写一条审计记录（失败不影响主流程）。 */
export function audit(db: DatabaseSync, at: number, actor: string, action: string, detail: string | null): void {
  db.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)').run(at, actor, action, detail);
}
