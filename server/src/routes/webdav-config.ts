/**
 * 客户端模式 WebDAV 转发的服务器级设置（M12 §3.1）。
 *
 * - `GET /api/webdav/config`：读取「允许转发到内网地址」开关（服务端持久化）。
 * - `PUT /api/webdav/config`：更新开关，非法值 400。
 *
 * 与 `/api/webdav/*` 的转发请求不同，本路由是普通 JSON 接口，需登录。
 */
import type { RouteContext, RouteResponse } from '../http.ts';
import {
  applyRelayConfigPatch,
  parseRelayConfigPatch,
  relayConfigView,
  ServerSettingError,
} from '../server-settings.ts';

export function handleRelayConfigGet(ctx: RouteContext): RouteResponse {
  return { status: 200, body: relayConfigView(ctx.db, ctx.config) };
}

export function handleRelayConfigPut(ctx: RouteContext): RouteResponse {
  try {
    const patch = parseRelayConfigPatch(ctx.body);
    return { status: 200, body: applyRelayConfigPatch(ctx.db, patch) };
  } catch (error) {
    if (error instanceof ServerSettingError) {
      return { status: 400, body: { error: 'invalid_config', message: error.message } };
    }
    throw error;
  }
}
