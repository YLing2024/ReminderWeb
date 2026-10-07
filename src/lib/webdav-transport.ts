/**
 * 客户端模式 WebDAV 连接方式（M11 §3.2）。
 *
 * - `auto`（推荐）：后端可达时优先同源代理，不可达（纯静态部署）时直连；
 * - `proxy`：始终经本应用后端 `/api/webdav` 转发；
 * - `direct`：浏览器直连 WebDAV（需目标允许跨域，或与本页同源）。
 */
export type WebDavTransportPreference = 'auto' | 'proxy' | 'direct';
export type WebDavTransport = 'proxy' | 'direct';

export const WEBDAV_TRANSPORT_PREFERENCES: ReadonlyArray<WebDavTransportPreference> = ['auto', 'proxy', 'direct'];

/** 解析设置里的连接方式；非法值回落 `auto`。纯函数。 */
export function parseTransportPreference(raw: unknown): WebDavTransportPreference {
  return raw === 'proxy' || raw === 'direct' ? raw : 'auto';
}

/** 依据偏好与后端可达性解析出**实际使用**的连接方式。纯函数。 */
export function resolveWebDavTransport(
  preference: WebDavTransportPreference,
  backendReachable: boolean,
): WebDavTransport {
  if (preference === 'direct') return 'direct';
  if (preference === 'proxy') return 'proxy';
  return backendReachable ? 'proxy' : 'direct';
}

/** 实际方式的一句话说明（设置页展示）。 */
export function transportExplanation(transport: WebDavTransport): string {
  return transport === 'proxy'
    ? '经本应用服务器转发（后端只做透传，不保存你的 WebDAV 口令）'
    : '浏览器直连（需要 WebDAV 允许跨域，或与本页同源）';
}

/** 偏好对应的选择项文案。 */
export function transportPreferenceLabel(preference: WebDavTransportPreference): string {
  if (preference === 'auto') return '自动（推荐）';
  if (preference === 'proxy') return '同源代理';
  return '直连';
}
