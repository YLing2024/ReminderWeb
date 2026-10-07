/**
 * WebDAV 同步配置、状态与云端备份管理路由（M7 §5 / M9 §1 §2）。
 *
 * - `GET  /api/sync/config`：读取同步配置（不含凭据）。
 * - `PUT  /api/sync/config`：更新自动同步开关 / 间隔 / 保留份数，非法值 400。
 * - `GET  /api/sync/status`：同步状态（含 nextSyncAt / lastMerged / lastAction）。
 * - `POST /api/sync/now`：立即双向同步。
 * - `POST /api/sync/upload`：立即备份（只上传，不拉取）。
 * - `GET  /api/sync/files`：云端备份列表（含 isOwn）。
 * - `POST /api/sync/restore`：从指定备份恢复（只读，绝不删除远端文件）。
 * - `DELETE /api/sync/files/:name`：删除本服务上传的备份（别人的 403）。
 */
import type { RouteContext, RouteResponse } from '../http.ts';
import { SyncActionError, type SyncStatus } from '../sync.ts';
import {
  applySyncConfigPatch,
  parseSyncConfigPatch,
  readSyncConfig,
  syncConfigView,
  SyncConfigError,
} from '../sync-config.ts';
import { WebDavError } from '../webdav.ts';

const DISABLED: SyncStatus = {
  enabled: false,
  url: '',
  lastSyncAt: null,
  lastUploadAt: null,
  lastResult: null,
  lastError: null,
  pendingChanges: false,
  remoteFiles: [],
  nextSyncAt: null,
  lastMerged: 0,
  lastAction: 'none',
};

export function handleSyncStatus(ctx: RouteContext): RouteResponse {
  return { status: 200, body: ctx.sync?.status() ?? DISABLED };
}

export async function handleSyncNow(ctx: RouteContext): Promise<RouteResponse> {
  const sync = ctx.sync;
  if (sync === null) {
    return { status: 409, body: { error: 'sync_disabled' } };
  }
  const status = await sync.runNow();
  if (status === null) {
    return { status: 409, body: { error: 'sync_in_progress' } };
  }
  return { status: 200, body: status };
}

export function handleSyncConfigGet(ctx: RouteContext): RouteResponse {
  if (ctx.sync !== null) return { status: 200, body: ctx.sync.configView() };
  const stored = readSyncConfig(ctx.db, ctx.config);
  return { status: 200, body: syncConfigView(stored, ctx.config) };
}

export function handleSyncConfigPut(ctx: RouteContext): RouteResponse {
  try {
    if (ctx.sync !== null) return { status: 200, body: ctx.sync.updateConfig(ctx.body) };
    const patch = parseSyncConfigPatch(ctx.body);
    const stored = applySyncConfigPatch(ctx.db, ctx.config, patch);
    return { status: 200, body: syncConfigView(stored, ctx.config) };
  } catch (error) {
    if (error instanceof SyncConfigError) {
      return { status: 400, body: { error: 'invalid_config', message: error.message } };
    }
    throw error;
  }
}

export async function handleSyncFiles(ctx: RouteContext): Promise<RouteResponse> {
  const sync = ctx.sync;
  if (sync === null) return { status: 200, body: { files: [] } };
  return { status: 200, body: { files: await sync.listFiles() } };
}

export async function handleSyncUpload(ctx: RouteContext): Promise<RouteResponse> {
  const sync = ctx.sync;
  if (sync === null) return { status: 409, body: { error: 'sync_disabled' } };
  const result = await sync.runUpload();
  if (result === null) return { status: 409, body: { error: 'sync_in_progress' } };
  return { status: 200, body: result };
}

export async function handleSyncRestore(ctx: RouteContext): Promise<RouteResponse> {
  const sync = ctx.sync;
  if (sync === null) return { status: 409, body: { error: 'sync_disabled' } };
  const name = readName(ctx.body);
  if (name === null) return { status: 400, body: { error: 'invalid_name', message: '请求缺少备份文件名' } };
  try {
    const result = await sync.restore(name);
    if (result === null) return { status: 409, body: { error: 'sync_in_progress' } };
    return { status: 200, body: result };
  } catch (error) {
    return syncErrorResponse(error);
  }
}

export async function handleSyncDeleteFile(ctx: RouteContext): Promise<RouteResponse> {
  const sync = ctx.sync;
  if (sync === null) return { status: 409, body: { error: 'sync_disabled' } };
  const raw = ctx.path.slice('/api/sync/files/'.length);
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return { status: 400, body: { error: 'invalid_name', message: '备份文件名不合法' } };
  }
  try {
    const result = await sync.deleteRemote(name);
    if (result === null) return { status: 409, body: { error: 'sync_in_progress' } };
    return { status: 200, body: { ok: true } };
  } catch (error) {
    return syncErrorResponse(error);
  }
}

function readName(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).name;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 手动云端操作错误 → HTTP 响应（未预期错误继续上抛交给统一 500）。 */
function syncErrorResponse(error: unknown): RouteResponse {
  if (error instanceof SyncActionError) {
    return { status: error.status, body: { error: error.code, message: error.message } };
  }
  if (error instanceof WebDavError) {
    const status = error.code === 'NOT_FOUND' ? 404 : 502;
    return { status, body: { error: 'sync_failed', message: error.message } };
  }
  throw error;
}
