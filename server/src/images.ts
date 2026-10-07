/**
 * 卡片背景图字节存储（M11 §2）。
 *
 * 背景图按文件名（basename，如 `card-bg-20260101-120000-abcd.jpg`）存，
 * 与前端 IndexedDB 键 `reminderweb:image:<name>`、备份包内 `images/<name>` 对齐。
 *
 * - 只存字节，不解析图像；名字必须是纯文件名（不得含路径分隔符或控制字符）。
 * - 所有写入都应由调用方放在一个事务里（见 `data.ts`）。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 单张图片字节上限（8 MiB；前端压缩到 1080px 后远小于此）。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 文件名长度上限。 */
export const MAX_IMAGE_NAME_LENGTH = 200;

export interface StoredImage {
  name: string;
  bytes: Uint8Array;
}

/** 合法图片名：非空、限长、不含路径分隔符 / 空字节。 */
export function isValidImageName(name: string): boolean {
  if (name === '' || name.length > MAX_IMAGE_NAME_LENGTH) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  // 禁止控制字符，避免头部 / 文件名注入。
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(0);
}

/** 读取全部图片名（升序）。 */
export function readImageNames(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT name FROM images ORDER BY name ASC').all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** 读取全部图片字节。 */
export function readImages(db: DatabaseSync): StoredImage[] {
  const rows = db.prepare('SELECT name, bytes FROM images ORDER BY name ASC').all() as Array<{
    name: string;
    bytes: unknown;
  }>;
  return rows.map((row) => ({ name: row.name, bytes: toBytes(row.bytes) }));
}

/** 读取单张图片字节；不存在返回 null。 */
export function readImage(db: DatabaseSync, name: string): Uint8Array | null {
  const row = db.prepare('SELECT bytes FROM images WHERE name = ?').get(name) as { bytes?: unknown } | undefined;
  if (row === undefined || row.bytes === undefined) return null;
  return toBytes(row.bytes);
}

/** 新增或覆盖单张图片（调用方负责事务与 revision）。 */
export function upsertImage(db: DatabaseSync, name: string, bytes: Uint8Array, at: number): void {
  db.prepare(
    'INSERT INTO images (name, bytes, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at',
  ).run(name, bytes, at);
}

/** 删除单张图片，返回是否删除成功。 */
export function deleteImage(db: DatabaseSync, name: string): boolean {
  const result = db.prepare('DELETE FROM images WHERE name = ?').run(name);
  return Number(result.changes) > 0;
}

/** 用给定集合整体替换图片库（调用方负责事务）。 */
export function replaceAllImages(db: DatabaseSync, images: StoredImage[], at: number): void {
  db.exec('DELETE FROM images');
  for (const image of images) {
    upsertImage(db, image.name, image.bytes, at);
  }
}
