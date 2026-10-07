/**
 * 服务端 WebDAV 客户端（M7 §4）。纯 `fetch` + 正则 XML 解析，零第三方依赖。
 *
 * 支持 PROPFIND(Depth:1) / MKCOL / PUT / GET / DELETE + Basic 认证；
 * 所有对外错误均为 `WebDavError`，`message` 已是可直接展示（并脱敏）的中文文案。
 * 凭据只从配置读取，不进入日志、URL 或错误信息。
 */
import type { Config } from './config.ts';

export const BACKUP_FILE_PREFIX = 'reminder-backup-';

export interface WebDavConfig {
  url: string;
  username: string;
  password: string;
  timeoutMs: number;
}

/** 远端一个备份文件的元信息。 */
export interface RemoteFile {
  name: string;
  size: number;
  lastModified: number;
  etag: string | null;
}

export interface WebDavDeps {
  fetchImpl?: typeof fetch;
}

export type WebDavErrorCode = 'INVALID_URL' | 'AUTH' | 'NOT_FOUND' | 'NOT_WEBDAV' | 'NETWORK' | 'HTTP';

export class WebDavError extends Error {
  readonly code: WebDavErrorCode;
  readonly status: number | undefined;

  constructor(code: WebDavErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'WebDavError';
    this.code = code;
    this.status = status;
  }
}

/** 由后端配置构造客户端配置（凭据只来自环境变量）。 */
export function webDavConfigFrom(config: Config): WebDavConfig {
  return {
    url: config.webdavUrl,
    username: config.webdavUsername,
    password: config.webdavPassword,
    timeoutMs: config.webdavTimeoutSeconds * 1000,
  };
}

/** 规范化目录地址：补协议、补尾斜杠、去 hash、剥离 URL 内嵌凭据；非 http(s) 拒绝。 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new WebDavError('INVALID_URL', 'WebDAV 地址不能为空');
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new WebDavError('INVALID_URL', 'WebDAV 地址格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebDavError('INVALID_URL', 'WebDAV 地址需以 http 或 https 开头');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.href;
}

/** 拼接 base 目录与文件名（文件名做 URL 编码）。 */
export function joinUrl(base: string, name: string): string {
  return `${base}${encodeURIComponent(name)}`;
}

/** Basic 认证头；用 UTF-8 → Base64，兼容中文口令。 */
export function buildAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** 是否为本应用产生的备份文件名。 */
export function isBackupName(name: string): boolean {
  return name.startsWith(BACKUP_FILE_PREFIX) && name.toLowerCase().endsWith('.zip');
}

/** 是否为严格合法的备份文件名（`reminder-backup-<yyyyMMdd-HHmmss>.zip`）。 */
export function isValidBackupName(name: string): boolean {
  return /^reminder-backup-\d{8}-\d{6}\.zip$/.test(name);
}

/** 从 href 取 basename（去查询串并解码）。 */
export function fileNameFromHref(href: string): string {
  const path = href.split('?')[0]!.split('#')[0]!;
  const withoutSlash = path.endsWith('/') ? path.slice(0, -1) : path;
  const last = withoutSlash.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTag(block: string, name: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i');
  const match = re.exec(block);
  return match === null ? null : decodeEntities(match[1]!.trim());
}

/** 解析 PROPFIND 响应：只留本应用 `*.zip`，按最后修改时间倒序。 */
export function parsePropfind(xml: string): RemoteFile[] {
  const responses: string[] = [];
  const re = /<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) responses.push(match[1]!);

  const byName = new Map<string, RemoteFile>();
  for (const block of responses) {
    const href = extractTag(block, 'href');
    if (href === null || href === '') continue;
    const name = fileNameFromHref(href);
    if (!isBackupName(name)) continue;
    const size = Number.parseInt(extractTag(block, 'getcontentlength') ?? '', 10);
    const modified = Date.parse(extractTag(block, 'getlastmodified') ?? '');
    const etagRaw = extractTag(block, 'getetag');
    byName.set(name, {
      name,
      size: Number.isFinite(size) ? size : 0,
      lastModified: Number.isFinite(modified) ? modified : 0,
      etag: etagRaw === null || etagRaw === '' ? null : etagRaw,
    });
  }
  return [...byName.values()].sort((a, b) => b.lastModified - a.lastModified || b.name.localeCompare(a.name));
}

/** HTTP 状态码 → 中文错误。 */
export function mapHttpError(status: number): WebDavError {
  if (status === 401 || status === 403) {
    return new WebDavError('AUTH', '用户名或密码不正确，或该账号无权访问此目录', status);
  }
  if (status === 404) {
    return new WebDavError('NOT_FOUND', '地址不对，服务器上找不到该路径', status);
  }
  if (status === 405) {
    return new WebDavError('NOT_WEBDAV', '该地址不像 WebDAV 服务（服务器拒绝了 PROPFIND）', status);
  }
  return new WebDavError('HTTP', `服务器返回 ${status}`, status);
}

/** fetch 层异常（网络 / 超时）→ 中文错误。 */
export function mapFetchError(error: unknown): WebDavError {
  if (error instanceof WebDavError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return new WebDavError('NETWORK', '连接超时，请检查地址与网络');
  return new WebDavError('NETWORK', '连不上服务器，请检查地址与网络');
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>';

async function send(
  config: WebDavConfig,
  method: string,
  url: string,
  deps: WebDavDeps,
  body?: Uint8Array | null,
  headers?: Record<string, string>,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (typeof fetchImpl !== 'function') throw new WebDavError('NETWORK', '连不上服务器，请检查地址与网络');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await fetchImpl(url, {
      method,
      headers: { Authorization: buildAuthHeader(config.username, config.password), ...headers },
      body: body ?? null,
      signal: controller.signal,
    });
  } catch (error) {
    throw mapFetchError(error);
  } finally {
    clearTimeout(timer);
  }
}

/** 列出远端本应用备份（时间倒序）。 */
export async function listBackups(config: WebDavConfig, deps: WebDavDeps = {}): Promise<RemoteFile[]> {
  const base = normalizeBaseUrl(config.url);
  const response = await send(config, 'PROPFIND', base, deps, new TextEncoder().encode(PROPFIND_BODY), {
    'Content-Type': 'application/xml; charset=utf-8',
    Depth: '1',
  });
  if (!response.ok) throw mapHttpError(response.status);
  return parsePropfind(await response.text());
}

async function ensureCollection(config: WebDavConfig, base: string, deps: WebDavDeps): Promise<void> {
  const response = await send(config, 'MKCOL', base, deps);
  // 目录已存在：MKCOL 按 RFC 4918 返回 405（部分服务器返回 301）。
  if (response.status === 405 || response.status === 301) return;
  if (!response.ok) throw mapHttpError(response.status);
}

/** 上传备份：先 MKCOL 建目录（已存在忽略），再 PUT。 */
export async function uploadFile(
  config: WebDavConfig,
  bytes: Uint8Array,
  fileName: string,
  deps: WebDavDeps = {},
): Promise<void> {
  const base = normalizeBaseUrl(config.url);
  await ensureCollection(config, base, deps);
  const response = await send(config, 'PUT', joinUrl(base, fileName), deps, bytes, {
    'Content-Type': 'application/zip',
  });
  if (!response.ok) throw mapHttpError(response.status);
}

/** 下载文件字节。 */
export async function downloadFile(config: WebDavConfig, fileName: string, deps: WebDavDeps = {}): Promise<Uint8Array> {
  const base = normalizeBaseUrl(config.url);
  const response = await send(config, 'GET', joinUrl(base, fileName), deps);
  if (!response.ok) throw mapHttpError(response.status);
  return new Uint8Array(await response.arrayBuffer());
}

/** 删除文件。 */
export async function deleteFile(config: WebDavConfig, fileName: string, deps: WebDavDeps = {}): Promise<void> {
  const base = normalizeBaseUrl(config.url);
  const response = await send(config, 'DELETE', joinUrl(base, fileName), deps);
  if (!response.ok) throw mapHttpError(response.status);
}
