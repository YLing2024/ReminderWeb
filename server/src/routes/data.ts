/**
 * 数据路由（需求 §6.2 / M11 §2）：
 * - `GET  /api/data`：读取快照（提醒 / 标签 / 设置 / 墓碑 + 图片名列表）。
 * - `GET  /api/data/full`：读取快照 + 全部卡片背景图字节（base64），迁移用。
 * - `PUT  /api/data`：按 `updatedAt` / 墓碑的增量合并。
 * - `PUT  /api/data/replace`：整库替换（仅迁移用，事务内完成、失败回滚）。
 */
import {
  mergeData,
  readRevision,
  readServerData,
  replaceServerData,
  writeMergedData,
} from '../data.ts';
import {
  deleteImage,
  isValidImageName,
  MAX_IMAGE_BYTES,
  readImage,
  readImages,
  readImageNames,
  upsertImage,
} from '../images.ts';
import { parseClientData, parseReplaceData } from '../serialize.ts';
import { HttpError, type RouteContext, type RouteResponse } from '../http.ts';

export function handleGetData(ctx: RouteContext): RouteResponse {
  const server = readServerData(ctx.db);
  return {
    status: 200,
    body: {
      revision: readRevision(ctx.db),
      reminders: server.reminders,
      tags: server.tags,
      settings: server.settings,
      tombstones: server.tombstones,
      imageNames: readImageNames(ctx.db),
    },
  };
}

/** 迁移用全量读取：附带图片字节（base64）。 */
export function handleGetFullData(ctx: RouteContext): RouteResponse {
  const server = readServerData(ctx.db);
  return {
    status: 200,
    body: {
      revision: readRevision(ctx.db),
      reminders: server.reminders,
      tags: server.tags,
      settings: server.settings,
      tombstones: server.tombstones,
      imageNames: readImageNames(ctx.db),
      images: readImages(ctx.db).map((image) => ({
        name: image.name,
        data: Buffer.from(image.bytes).toString('base64'),
      })),
    },
  };
}

export function handlePutData(ctx: RouteContext): RouteResponse {
  const serverRevisionBefore = readRevision(ctx.db);
  const client = parseClientData(ctx.body);
  const server = readServerData(ctx.db);
  const outcome = mergeData(server, {
    reminders: client.reminders,
    tags: client.tags,
    settings: client.settings,
    tombstones: client.tombstones,
  });
  const revision = writeMergedData(ctx.db, outcome);
  // 本机数据变更 → 触发 WebDAV 延迟上传（节流，未启用时不生效）。
  if (outcome.changed) ctx.sync?.markLocalChange();
  const actor = ctx.identity?.username ?? 'unknown';
  ctx.db
    .prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
    .run(
      ctx.now,
      actor,
      'put_data',
      JSON.stringify({
        baseRevision: client.baseRevision,
        serverRevisionBefore,
        revision,
        rejected: client.rejected,
      }),
    );
  return {
    status: 200,
    body: {
      revision,
      serverRevisionBefore,
      baseRevision: client.baseRevision,
      rejected: client.rejected,
      reminders: outcome.reminders,
      tags: outcome.tags,
      settings: outcome.settings,
      tombstones: outcome.tombstones,
      imageNames: readImageNames(ctx.db),
    },
  };
}

/**
 * 整库替换（M11 §2）：用请求体替换全部数据（提醒 / 标签 / 设置 / 图片字节）。
 * 只在确认迁移时调用，与增量 `PUT /api/data` 完全分开。
 */
export function handlePutReplace(ctx: RouteContext): RouteResponse {
  const serverRevisionBefore = readRevision(ctx.db);
  const parsed = parseReplaceData(ctx.body);
  let revision: number;
  try {
    revision = replaceServerData(
      ctx.db,
      {
        reminders: parsed.reminders,
        tags: parsed.tags,
        settings: parsed.settings,
        images: parsed.images.map((image) => ({ name: image.name, bytes: image.bytes })),
      },
      ctx.now,
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // 事务已回滚：保持原数据不变，返回可读原因。
    return { status: 500, body: { error: 'replace_failed', message: '整库替换失败，数据未改动' } };
  }
  ctx.sync?.markLocalChange();
  const actor = ctx.identity?.username ?? 'unknown';
  ctx.db
    .prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
    .run(
      ctx.now,
      actor,
      'replace_data',
      JSON.stringify({
        serverRevisionBefore,
        revision,
        reminders: parsed.reminders.length,
        tags: parsed.tags.length,
        images: parsed.images.length,
        rejected: parsed.rejected,
      }),
    );
  const server = readServerData(ctx.db);
  return {
    status: 200,
    body: {
      revision,
      serverRevisionBefore,
      rejected: parsed.rejected,
      counts: {
        reminders: server.reminders.length,
        tags: server.tags.length,
        images: readImageNames(ctx.db).length,
      },
      reminders: server.reminders,
      tags: server.tags,
      settings: server.settings,
      tombstones: server.tombstones,
      imageNames: readImageNames(ctx.db),
    },
  };
}

/** 从 `/api/images/<name>` 路径取图片名（解码）；非法编码返回 null。 */
function imageNameFromPath(path: string): string | null {
  const raw = path.slice('/api/images/'.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** 上传单张卡片背景图（原始字节）。同名覆盖。 */
export function handlePutImage(ctx: RouteContext): RouteResponse {
  const name = imageNameFromPath(ctx.path);
  const bytes = ctx.rawBody ?? new Uint8Array(0);
  if (name === null || !isValidImageName(name)) {
    return { status: 400, body: { error: 'invalid_name', message: '图片文件名不合法' } };
  }
  if (bytes.length === 0) {
    return { status: 400, body: { error: 'empty_image', message: '图片内容为空' } };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { status: 413, body: { error: 'payload_too_large', message: '图片过大' } };
  }
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    upsertImage(ctx.db, name, bytes, ctx.now);
    ctx.db.exec('COMMIT');
  } catch (error) {
    ctx.db.exec('ROLLBACK');
    throw error;
  }
  ctx.sync?.markLocalChange();
  return { status: 200, body: { ok: true, name } };
}

/** 删除单张卡片背景图。 */
export function handleDeleteImage(ctx: RouteContext): RouteResponse {
  const name = imageNameFromPath(ctx.path);
  if (name === null || !isValidImageName(name)) {
    return { status: 400, body: { error: 'invalid_name', message: '图片文件名不合法' } };
  }
  ctx.db.exec('BEGIN IMMEDIATE');
  try {
    deleteImage(ctx.db, name);
    ctx.db.exec('COMMIT');
  } catch (error) {
    ctx.db.exec('ROLLBACK');
    throw error;
  }
  return { status: 200, body: { ok: true } };
}

/** 读取单张卡片背景图原始字节。 */
export function handleGetImage(ctx: RouteContext): RouteResponse {
  const name = imageNameFromPath(ctx.path);
  if (name === null || !isValidImageName(name)) {
    return { status: 400, body: { error: 'invalid_name', message: '图片文件名不合法' } };
  }
  const bytes = readImage(ctx.db, name);
  if (bytes === null) return { status: 404, body: { error: 'not_found' } };
  return {
    status: 200,
    rawBody: bytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  };
}
