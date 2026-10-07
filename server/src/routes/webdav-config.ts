/**
 * 服务器级 WebDAV 设置路由。
 *
 * - `GET /api/webdav/config`：读取 WebDAV 连接与自动同步设置（服务端持久化）。
 * - `PUT /api/webdav/config`：部分更新，非法值 400（中文）。
 *
 * 口令只进库、绝不回传；`detail` 审计只记哪些字段变了与是否改口令，不记口令值与完整地址。
 * 与 `/api/webdav/*` 的转发请求不同，本路由是普通 JSON 接口，需登录。
 */
import type { RouteContext, RouteResponse } from '../http.ts';
import {
  applyWebdavConfigPatch,
  parseWebdavConfigPatch,
  readServerSettings,
  serverSettingsView,
  ServerSettingError,
} from '../server-settings.ts';

export function handleRelayConfigGet(ctx: RouteContext): RouteResponse {
  return { status: 200, body: serverSettingsView(readServerSettings(ctx.db, ctx.config)) };
}

export function handleRelayConfigPut(ctx: RouteContext): RouteResponse {
  try {
    const patch = parseWebdavConfigPatch(ctx.body);
    const result = applyWebdavConfigPatch(ctx.db, ctx.config, patch);
    // 改完立即生效：同步引擎重读设置并重排定时器，无需重启。
    ctx.sync?.reloadSettings();
    const actor = ctx.identity?.username ?? 'unknown';
    ctx.db
      .prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
      .run(
        ctx.now,
        actor,
        'webdav_config_update',
        JSON.stringify({ changed: result.changed, passwordChanged: result.passwordChanged }),
      );
    return { status: 200, body: serverSettingsView(result.settings) };
  } catch (error) {
    if (error instanceof ServerSettingError) {
      return { status: 400, body: { error: 'invalid_config', message: error.message } };
    }
    throw error;
  }
}
