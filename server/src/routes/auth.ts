/**
 * 认证路由（需求 §5）：登录 / 登出 / 当前用户。
 */
import {
  SESSION_COOKIE,
  buildClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  hashPassword,
  parseCookies,
  verifyPassword,
  type PasswordHash,
} from '../auth.ts';
import type { RouteContext, RouteResponse } from '../http.ts';

/** 登录失败固定延迟，防用户枚举（需求 §5.4）。 */
export const LOGIN_FAILURE_DELAY_MS = 150;

/** 用户不存在时用于等时比对的哑哈希（首次使用时才计算）。 */
let dummyHash: PasswordHash | null = null;
function getDummyHash(): PasswordHash {
  if (dummyHash === null) dummyHash = hashPassword('__not_a_real_password__', Buffer.from('00'.repeat(16), 'hex'));
  return dummyHash;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function readLoginBody(body: unknown): { username: string; password: string } | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.username !== 'string' || typeof record.password !== 'string') return null;
  if (record.username.trim() === '' || record.password === '') return null;
  return { username: record.username.trim(), password: record.password };
}

export async function handleLogin(ctx: RouteContext): Promise<RouteResponse> {
  if (ctx.config.authMode !== 'builtin') {
    return { status: 400, body: { error: 'login_not_available' } };
  }
  const credentials = readLoginBody(ctx.body);
  if (credentials === null) {
    return { status: 400, body: { error: 'invalid_request' } };
  }
  if (ctx.rateLimiter.isBlocked(ctx.ip)) {
    return { status: 429, body: { error: 'too_many_requests' } };
  }
  const row = ctx.db.prepare('SELECT username, salt, hash FROM users WHERE username = ?').get(credentials.username) as
    | { username: string; salt: string; hash: string }
    | undefined;
  let ok = false;
  let username = credentials.username;
  if (row === undefined) {
    // 用户不存在也做一次 scrypt，避免时间侧信道枚举用户。
    verifyPassword(credentials.password, getDummyHash());
  } else {
    ok = verifyPassword(credentials.password, { salt: row.salt, hash: row.hash });
    username = row.username;
  }
  if (!ok) {
    ctx.rateLimiter.recordFailure(ctx.ip);
    await delay(LOGIN_FAILURE_DELAY_MS);
    return { status: 401, body: { error: 'invalid_credentials' } };
  }
  ctx.rateLimiter.reset(ctx.ip);
  const ttlMs = ctx.config.sessionTtlDays * 24 * 60 * 60 * 1000;
  const session = createSession(ctx.db, username, ttlMs, ctx.now);
  ctx.db
    .prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
    .run(ctx.now, username, 'login', null);
  return {
    status: 200,
    body: { username: credentials.username },
    cookies: [buildSessionCookie(session.token, Math.floor(ttlMs / 1000), ctx.config.cookieSameSite)],
  };
}

export function handleLogout(ctx: RouteContext): RouteResponse {
  const cookieHeader = ctx.headers.cookie;
  const cookies = parseCookies(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader);
  const token = cookies[SESSION_COOKIE];
  if (token !== undefined && token !== '') deleteSession(ctx.db, token);
  return { status: 200, body: { ok: true }, cookies: [buildClearCookie(ctx.config.cookieSameSite)] };
}

export function handleMe(ctx: RouteContext): RouteResponse {
  const identity = ctx.identity;
  if (identity === null) return { status: 401, body: { error: 'unauthorized' } };
  return { status: 200, body: { username: identity.username, authMode: identity.mode } };
}
