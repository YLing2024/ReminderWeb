/**
 * WebDAV 同源转发（M11 §3.1）。
 *
 * `* /api/webdav/*`：把请求转发到前端随请求提供的目标 WebDAV。
 * - 目标地址与凭据来自请求头 `X-Dav-Url` / `X-Dav-User` / `X-Dav-Password`，
 *   **仅本次请求使用**：不落库、不写日志、不出现在任何响应里；
 * - 支持 `PROPFIND / PUT / GET / HEAD / DELETE / MKCOL`；
 * - 透传请求侧 `Depth` / `Content-Type` / `If-Match` / 请求体，
 *   响应侧原样返回状态码与 `DAV` / `ETag` / `Content-Length` / `Content-Type`；
 * - 只允许 http/https，默认拒绝回环 / 内网 / 链路本地 / 元数据地址（SSRF 防护）；
 * - 不做任何缓存。
 */
import {
  buildAuthHeader,
} from '../webdav.ts';
import { checkRelayTarget } from '../ssrf.ts';
import { readServerSettings } from '../server-settings.ts';
import type { RouteContext, RouteResponse } from '../http.ts';

/** 允许转发的动词。 */
export const RELAY_METHODS: ReadonlySet<string> = new Set(['PROPFIND', 'PUT', 'GET', 'HEAD', 'DELETE', 'MKCOL']);

function firstHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** 只透传约定的响应头。 */
function pickResponseHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['dav', 'etag', 'content-length', 'content-type'] as const) {
    const value = response.headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

export async function handleWebDavRelay(ctx: RouteContext): Promise<RouteResponse> {
  const method = ctx.method;
  if (!RELAY_METHODS.has(method)) {
    return { status: 405, body: { error: 'method_not_allowed', message: '不支持的转发动词' } };
  }

  const target = firstHeader(ctx.headers, 'x-dav-url');
  if (target === undefined || target.trim() === '') {
    return { status: 400, body: { error: 'missing_target', message: '缺少目标地址' } };
  }

  const allowPrivate = readServerSettings(ctx.db, ctx.config).relayAllowPrivate;
  const check = checkRelayTarget(target.trim(), allowPrivate);
  if (!check.ok) {
    // 可读错误并指向设置页开关（M12 §3.1）。
    const reason = check.reason ?? '目标地址不被允许';
    const hint = allowPrivate
      ? ''
      : '若你的 WebDAV 装在局域网（NAS、路由器等），请在设置页打开「允许转发到内网地址」。';
    return {
      status: 403,
      body: { error: 'target_not_allowed', message: hint === '' ? reason : `${reason}。${hint}` },
    };
  }

  const user = firstHeader(ctx.headers, 'x-dav-user') ?? '';
  const password = firstHeader(ctx.headers, 'x-dav-password') ?? '';

  const outbound: Record<string, string> = {
    Authorization: buildAuthHeader(user, password),
  };
  const depth = firstHeader(ctx.headers, 'depth');
  if (depth !== undefined) outbound.Depth = depth;
  const contentType = firstHeader(ctx.headers, 'content-type');
  if (contentType !== undefined) outbound['Content-Type'] = contentType;
  const ifMatch = firstHeader(ctx.headers, 'if-match');
  if (ifMatch !== undefined) outbound['If-Match'] = ifMatch;

  const hasBody = method !== 'GET' && method !== 'HEAD' && ctx.rawBody !== undefined && ctx.rawBody.length > 0;
  const init: RequestInit = {
    method,
    headers: outbound,
    body: hasBody ? ctx.rawBody : undefined,
    // 不自动跟随重定向：避免借 3xx 绕过 SSRF 校验转发到内网。
    redirect: 'manual',
  };

  try {
    const response = await fetch(target.trim(), init);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      rawBody: bytes,
      headers: {
        ...pickResponseHeaders(response),
        'Cache-Control': 'no-store',
      },
    };
  } catch {
    // 不打印目标地址与凭据；只回可读原因。
    return { status: 502, body: { error: 'relay_failed', message: '转发失败：无法连接目标 WebDAV' } };
  }
}
