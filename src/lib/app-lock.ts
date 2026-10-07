/**
 * 应用锁密码：任意字符（字母 / 数字 / 符号 / 空格 / 中文 / emoji），长度 1–128。
 *
 * 哈希（v2）：PBKDF2-SHA-256，16 字节随机盐，210000 次迭代，导出 32 字节。
 * 存储结构（写在 `src/lib/storage.ts` 的 `appLockPasswordHash` 字段）：
 *   { v: 2, algo: 'PBKDF2-SHA-256', salt: <base64>, iterations: 210000, hash: <base64> }
 *
 * 向后兼容（v1）：旧版存的是 `sha256('reminderweb-pin:' + 密码)` 的十六进制字符串。
 * `verifyStoredPassword` 同时接受两种格式：v1 校验通过后返回可写入的 v2 凭据，
 * 调用方据此自动升级，老用户不会被升级锁在门外。
 *
 * 密码、盐、哈希只进本地 IndexedDB；不联网、不写日志、不进导出备份。
 * crypto.subtle 仅在安全上下文（HTTPS / 本地开发）可用。
 */

/** 密码长度上限（与输入框 maxLength 一致，按 UTF-16 码元计）。 */
export const PASSWORD_MAX_LENGTH = 128;
/** 密码长度下限：仅要求非空。 */
export const PASSWORD_MIN_LENGTH = 1;

/** v2 哈希参数。 */
export const PBKDF2_ALGO = 'PBKDF2-SHA-256';
export const PBKDF2_ITERATIONS = 210_000;
export const PBKDF2_SALT_BYTES = 16;
export const PBKDF2_HASH_BYTES = 32;

/** v1 旧哈希前缀，必须与历史实现逐字一致才能解开老用户的锁。 */
const LEGACY_PREFIX = 'reminderweb-pin:';

/** v2 凭据：只存盐与摘要，不含明文。 */
export interface AppLockCredential {
  v: 2;
  algo: typeof PBKDF2_ALGO;
  /** base64 编码的 16 字节盐。 */
  salt: string;
  /** 迭代次数（当前固定 210000，读取时以存储值为准）。 */
  iterations: number;
  /** base64 编码的 32 字节导出密钥。 */
  hash: string;
}

/** 应用锁本地存储值：v2 凭据对象，或 v1 遗留的十六进制摘要字符串。 */
export type StoredAppLock = AppLockCredential | string;

export interface VerifyResult {
  /** 密码是否正确。 */
  ok: boolean;
  /** 若为 v1 且校验通过，这里给出应写回的 v2 凭据；否则为 null。 */
  upgraded: AppLockCredential | null;
}

/**
 * 合法密码：任意字符，长度 1–128。
 * 不做 trim、不做任何字符过滤——用户输入什么就校验什么。
 */
export function isValidPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    PBKDF2_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** 用新算法为明文密码生成 v2 凭据（每次调用都会生成新的随机盐）。 */
export async function hashPassword(password: string): Promise<AppLockCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const derived = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return {
    v: 2,
    algo: PBKDF2_ALGO,
    salt: bytesToBase64(salt),
    iterations: PBKDF2_ITERATIONS,
    hash: bytesToBase64(derived),
  };
}

/** 定时无关的朴素比较，避免按字节提前返回。 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** 判断一个值是否为结构完整的 v2 凭据。 */
export function isAppLockCredential(value: unknown): value is AppLockCredential {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 2 &&
    record.algo === PBKDF2_ALGO &&
    typeof record.salt === 'string' &&
    typeof record.iterations === 'number' &&
    record.iterations > 0 &&
    typeof record.hash === 'string'
  );
}

/** 用凭据内的盐与迭代次数校验明文。 */
export async function verifyCredential(password: string, credential: AppLockCredential): Promise<boolean> {
  try {
    const derived = await deriveBits(password, base64ToBytes(credential.salt), credential.iterations);
    return equalBytes(derived, base64ToBytes(credential.hash));
  } catch {
    return false;
  }
}

/** v1：`sha256('reminderweb-pin:' + 密码)` 的十六进制摘要。 */
export async function hashLegacyPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(`${LEGACY_PREFIX}${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

/** v1 校验。 */
export async function verifyLegacyPassword(password: string, legacyHash: string): Promise<boolean> {
  return (await hashLegacyPassword(password)) === legacyHash;
}

/**
 * 统一的解锁校验：
 * - v2 凭据：直接校验，结果不含升级。
 * - v1 摘要：旧算法校验；通过则额外生成 v2 凭据供调用方写回（自动升级）。
 */
export async function verifyStoredPassword(password: string, stored: StoredAppLock): Promise<VerifyResult> {
  if (typeof stored === 'string') {
    const ok = await verifyLegacyPassword(password, stored);
    if (!ok) return { ok: false, upgraded: null };
    return { ok: true, upgraded: await hashPassword(password) };
  }
  if (!isAppLockCredential(stored)) return { ok: false, upgraded: null };
  return { ok: await verifyCredential(password, stored), upgraded: null };
}
