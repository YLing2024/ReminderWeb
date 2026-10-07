/**
 * 健康检查与版本路由（需求 §6.2）。`/api/health` 免认证且不含任何敏感信息。
 */
import { getSchemaVersion } from '../db.ts';
import { readRevision } from '../data.ts';
import type { RouteContext, RouteResponse } from '../http.ts';

export const SERVER_NAME = 'reminderweb';
export const SERVER_VERSION = '0.1.0';

export function handleHealth(ctx: RouteContext): RouteResponse {
  return {
    status: 200,
    body: { ok: true, revision: readRevision(ctx.db), authMode: ctx.config.authMode },
  };
}

export function handleVersion(ctx: RouteContext): RouteResponse {
  return {
    status: 200,
    body: { server: SERVER_NAME, version: SERVER_VERSION, schemaVersion: getSchemaVersion(ctx.db) },
  };
}
