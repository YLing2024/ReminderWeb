/**
 * 极简 HTTP 服务（需求 §3 §6）：路由、JSON 解析（含体积上限）、统一错误体、静态文件服务。
 *
 * 不依赖 express/koa；只使用 `node:http`。请求处理流程：
 *   解析 URL → 读体（上限 2MiB）→ 解析身份 → 分发路由 / 静态文件 → 写响应。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { clientIp, resolveIdentity, type Identity, type RateLimiter } from './auth.ts';
import type { Config } from './config.ts';
import { createLogger, type Logger } from './log.ts';
import { handleGetData, handlePutData } from './routes/data.ts';
import { handleLogin, handleLogout, handleMe } from './routes/auth.ts';
import { handleHealth, handleVersion } from './routes/health.ts';

/** 请求体大小上限：2 MiB（需求 §6.2）。 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 统一业务错误：`status` + 稳定错误码。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export interface RouteContext {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  identity: Identity | null;
  config: Config;
  db: DatabaseSync;
  now: number;
  ip: string;
  rateLimiter: RateLimiter;
}

export interface RouteResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  cookies?: string[];
}

export type RouteHandler = (ctx: RouteContext) => RouteResponse | Promise<RouteResponse>;

export interface AppOptions {
  config: Config;
  db: DatabaseSync;
  rateLimiter: RateLimiter;
  now?: () => number;
  logger?: Logger;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function sendJson(res: ServerResponse, status: number, body: unknown, cookies?: string[]): void {
  const payload = JSON.stringify(body ?? null);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (cookies !== undefined && cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  res.end(payload);
}

/** 读取请求体，超过上限抛 413，解析失败抛 400。 */
export function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on('data', (chunk: Uint8Array) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finish(() => {
          reject(new HttpError(413, 'payload_too_large'));
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish(() => {
        if (size === 0) {
          resolvePromise(undefined);
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolvePromise(JSON.parse(text));
        } catch {
          reject(new HttpError(400, 'invalid_json'));
        }
      });
    });
    req.on('error', () => {
      finish(() => reject(new HttpError(400, 'invalid_body')));
    });
  });
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * 静态文件服务：只允许 `dist/` 下的普通文件；拒绝点文件与路径穿越；
 * 未知路径回退 `index.html`（SPA）。绝不返回 `server/`、`.env` 等仓库文件。
 */
function serveStatic(res: ServerResponse, config: Config, pathname: string): void {
  const decoded = decodePathname(pathname);
  if (decoded === null || decoded.includes('\0')) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const segments = decoded.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const root = resolve(config.staticDir);
  const candidate = resolve(join(root, ...segments));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  if (candidate !== root && existsSync(candidate) && statSync(candidate).isFile()) {
    const bytes = readFileSync(candidate);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypeFor(candidate));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', segments.length === 0 ? 'no-cache' : 'public, max-age=3600');
    res.end(bytes);
    return;
  }
  const indexPath = join(root, 'index.html');
  if (existsSync(indexPath)) {
    const bytes = readFileSync(indexPath);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(bytes);
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}

const PUBLIC_ROUTES = new Set(['GET /api/health', 'POST /api/auth/login']);

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

async function dispatch(ctx: RouteContext): Promise<RouteResponse> {
  const key = routeKey(ctx.method, ctx.path);
  if (key === 'GET /api/health') return handleHealth(ctx);
  if (key === 'GET /api/version') return handleVersion(ctx);
  if (key === 'POST /api/auth/login') return handleLogin(ctx);
  if (key === 'POST /api/auth/logout') return handleLogout(ctx);
  if (key === 'GET /api/auth/me') return handleMe(ctx);
  if (key === 'GET /api/data') return handleGetData(ctx);
  if (key === 'PUT /api/data') return handlePutData(ctx);
  return { status: 404, body: { error: 'not_found' } };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: AppOptions): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const rawUrl = req.url ?? '/';
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;

  if (!path.startsWith('/api/')) {
    if (options.config.serveStatic) serveStatic(res, options.config, path);
    else sendJson(res, 404, { error: 'not_found' });
    return;
  }

  const key = routeKey(method, path);
  let body: unknown = undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    body = await readJsonBody(req);
  }

  const identity = PUBLIC_ROUTES.has(key) ? null : resolveIdentity(req.headers, { mode: options.config.authMode, db: options.db });
  if (!PUBLIC_ROUTES.has(key) && identity === null) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const ctx: RouteContext = {
    method,
    path,
    headers: req.headers,
    body,
    identity,
    config: options.config,
    db: options.db,
    now: options.now?.() ?? Date.now(),
    ip: clientIp(req.headers, req.socket?.remoteAddress, options.config.trustProxy),
    rateLimiter: options.rateLimiter,
  };
  const response = await dispatch(ctx);
  sendJson(res, response.status, response.body, response.cookies);
}

/** 创建 HTTP 服务器（不自动 listen，便于测试用端口 0）。 */
export function createAppServer(options: AppOptions): Server {
  const logger = options.logger ?? createLogger(options.config.logLevel);
  return createServer((req, res) => {
    void handleRequest(req, res, options).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code });
        return;
      }
      logger.error(`请求处理失败：${error instanceof Error ? error.message : '未知错误'}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });
}
