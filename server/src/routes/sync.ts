/**
 * WebDAV 同步状态与手动触发路由（M7 §5）。
 *
 * - `GET /api/sync/status`：返回同步状态（不含凭据与远端其它文件信息）。
 * - `POST /api/sync/now`：立即执行一次同步；已有周期在跑或未启用时返回 409。
 */
import type { RouteContext, RouteResponse } from '../http.ts';
import type { SyncStatus } from '../sync.ts';

const DISABLED: SyncStatus = {
  enabled: false,
  url: '',
  lastSyncAt: null,
  lastUploadAt: null,
  lastResult: null,
  lastError: null,
  pendingChanges: false,
  remoteFiles: [],
};

export function handleSyncStatus(ctx: RouteContext): RouteResponse {
  return { status: 200, body: ctx.sync?.status() ?? DISABLED };
}

export async function handleSyncNow(ctx: RouteContext): Promise<RouteResponse> {
  const sync = ctx.sync;
  if (sync === null || !sync.status().enabled) {
    return { status: 409, body: { error: 'sync_disabled' } };
  }
  const status = await sync.runNow();
  if (status === null) {
    return { status: 409, body: { error: 'sync_in_progress' } };
  }
  return { status: 200, body: status };
}
