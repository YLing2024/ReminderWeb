/**
 * 认证与授权（需求 §5）。
 *
 * - `builtin`：scrypt 加盐口令校验 + 随机会话令牌（只存 SHA-256 摘要）；
 * - `sso`：只读网关注入的 `X-Auth-User`；
 * - `none`：本机开发，所有请求视为用户 `dev`。
 *
 * 口令、派生哈希、会话令牌、Cookie 值一律不写日志、不进错误响应。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthMode } from './config.ts';

export const SESSION_COOKIE = '__Host-rw_session';
export const SSR_CONSTANT = 'reminderweb';

/** scrypt 参数（需求 §5.1）。 */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export interface PasswordHash {
  salt: string;
  hash: string;
}

/** scrypt 加盐派生；返回十六进制盐与摘要。 */
export function hashPassword(password: string, salt: Uint8Array = randomBytes(SALT_BYTES)): PasswordHash {
  const derived = scryptSync(password, salt, KEY_BYTES, SCRYPT_PARAMS);
  return { salt: Buffer.from(salt).toString('hex'), hash: derived.toString('hex') };
}

/** 常量时间比对口令；任何异常都返回 false。 */
export function verifyPassword(password: string, stored: PasswordHash): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(stored.hash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_BYTES) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(password, Buffer.from(stored.salt, 'hex'), KEY_BYTES, SCRYPT_PARAMS);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** SHA-256 十六进制摘要（用于会话令牌）。 */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 32 字节随机会话令牌。 */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/* --------------------------- 用户初始化 --------------------------- */

export interface EnsureUserResult {
  created: boolean;
  /** 仅当口令留空且首次建库时生成，调用方只打印一次后丢弃。 */
  generatedPassword?: string;
}

/** 首次启动建立 builtin 用户；已存在则不动。口令留空时生成一次性随机口令。 */
export function ensureInitialUser(db: DatabaseSync, username: string, configuredPassword: string, at = Date.now()): EnsureUserResult {
  const exists = db.prepare('SELECT username FROM users WHERE username = ?').get(username) as
    | { username: string }
    | undefined;
  if (exists !== undefined) return { created: false };
  const password = configuredPassword.trim() === '' ? randomBytes(12).toString('base64url') : configuredPassword;
  const stored = hashPassword(password);
  db.prepare('INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)').run(
    username,
    stored.salt,
    stored.hash,
    at,
  );
  return { created: true, generatedPassword: configuredPassword.trim() === '' ? password : undefined };
}

/* --------------------------- 会话管理 --------------------------- */

export function createSession(
  db: DatabaseSync,
  username: string,
  ttlMs: number,
  at = Date.now(),
): { token: string; expiresAt: number } {
  const token = createSessionToken();
  const expiresAt = at + ttlMs;
  db.prepare('INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256Hex(token),
    username,
    at,
    expiresAt,
  );
  return { token, expiresAt };
}

/** 校验会话；过期则删除并返回 null。 */
export function getSessionUsername(db: DatabaseSync, token: string, at = Date.now()): string | null {
  const row = db.prepare('SELECT username, expires_at FROM sessions WHERE token_hash = ?').get(sha256Hex(token)) as
    | { username: string; expires_at: number }
    | undefined;
  if (row === undefined) return null;
  if (row.expires_at <= at) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
    return null;
  }
  return row.username;
}

export function deleteSession(db: DatabaseSync, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
}

/* --------------------------- Cookie --------------------------- */

export function buildSessionCookie(token: string, ttlSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

export function buildClearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** 解析 Cookie 头，返回键值表。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header === '') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key !== '') out[key] = value;
  }
  return out;
}

/* --------------------------- SSO --------------------------- */

const SSO_HEADER = 'x-auth-user';

/** 读取并校验 `X-Auth-User`；缺失或非法返回 null。 */
export function readSsoUser(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers[SSO_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 200) return null;
  // 禁止控制字符 / 换行，避免头注入与日志污染。
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return trimmed;
}

/* --------------------------- 限流 --------------------------- */

export const LOGIN_WINDOW_MS = 10 * 60 * 1000;

export interface RateLimiter {
  isBlocked(ip: string): boolean;
  recordFailure(ip: string): void;
  reset(ip: string): void;
}

interface RateEntry {
  count: number;
  windowStart: number;
}

/** 每 IP 滑动窗口登录失败计数。`now` 可注入便于测试。 */
export function createRateLimiter(options: {
  limit: number;
  windowMs?: number;
  now?: () => number;
}): RateLimiter {
  const limit = options.limit;
  const windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, RateEntry>();

  function current(ip: string): RateEntry | undefined {
    const entry = entries.get(ip);
    if (entry === undefined) return undefined;
    if (now() - entry.windowStart >= windowMs) {
      entries.delete(ip);
      return undefined;
    }
    return entry;
  }

  return {
    isBlocked(ip) {
      const entry = current(ip);
      return entry !== undefined && entry.count >= limit;
    },
    recordFailure(ip) {
      const entry = current(ip);
      if (entry === undefined) entries.set(ip, { count: 1, windowStart: now() });
      else entry.count += 1;
    },
    reset(ip) {
      entries.delete(ip);
    },
  };
}

/* --------------------------- 请求身份 --------------------------- */

export interface Identity {
  username: string;
  mode: AuthMode;
}

export interface AuthDeps {
  mode: AuthMode;
  db: DatabaseSync;
  now?: () => number;
}

/**
 * 解析当前请求身份；未认证返回 null。
 * builtin 读 Cookie 会话，sso 读 X-Auth-User，none 固定 dev。
 */
export function resolveIdentity(
  headers: Record<string, string | string[] | undefined>,
  deps: AuthDeps,
): Identity | null {
  if (deps.mode === 'none') return { username: 'dev', mode: 'none' };
  if (deps.mode === 'sso') {
    const username = readSsoUser(headers);
    return username === null ? null : { username, mode: 'sso' };
  }
  const cookieHeader = headers.cookie;
  const cookies = parseCookies(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader);
  const token = cookies[SESSION_COOKIE];
  if (token === undefined || token === '') return null;
  const username = getSessionUsername(deps.db, token, deps.now?.() ?? Date.now());
  return username === null ? null : { username, mode: 'builtin' };
}

/** 取真实客户端 IP（用于限流）。 */
export function clientIp(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof value === 'string' && value.trim() !== '') {
      const first = value.split(',')[0]?.trim();
      if (first !== undefined && first !== '') return first;
    }
  }
  return remoteAddress !== undefined && remoteAddress !== '' ? remoteAddress : 'unknown';
}
