/**
 * 环境变量解析与校验（需求 §4）。
 *
 * 纯函数 `loadConfig(env)`：非法值直接抛 `ConfigError`，由启动入口打印原因并退出。
 * 启动时绝不在日志中输出 `AUTH_PASSWORD` 等敏感值。
 */
import { resolve } from 'node:path';

export type AuthMode = 'builtin' | 'sso' | 'none';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** 会话 Cookie 的 SameSite 策略；`none` 用于前后端分离的跨站部署（必须配合 Secure）。 */
export type CookieSameSite = 'lax' | 'none';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  authMode: AuthMode;
  authUser: string;
  authPassword: string;
  sessionTtlDays: number;
  loginRateLimit: number;
  trustProxy: boolean;
  serveStatic: boolean;
  logLevel: LogLevel;
  nodeEnv: string;
  /** 由后端直接服务的静态产物目录（构建产物 dist/）。 */
  staticDir: string;
  /** WebDAV 双向同步（M7）。 */
  webdavEnabled: boolean;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  /** 定时轮询远端间隔（分钟，下限 1）。 */
  webdavIntervalMinutes: number;
  /** 本机数据变动后的延迟上传（秒，合并节流）。 */
  webdavDebounceSeconds: number;
  /** 上传的包是否加密（与安卓端「备份数据加密」一致）。 */
  webdavEncrypt: boolean;
  /** 仅保留最近 N 份由本服务上传的备份。 */
  webdavKeep: number;
  /** 单次 HTTP 请求超时（秒）。 */
  webdavTimeoutSeconds: number;
  /** 跨域白名单（精确来源，逗号分隔）；空数组 = 不启用 CORS。绝不使用 `*`。 */
  allowedOrigins: string[];
  /** 会话 Cookie 的 SameSite 策略。 */
  cookieSameSite: CookieSameSite;
}

/** 配置错误：`message` 可直接展示给运维。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const AUTH_MODES: readonly AuthMode[] = ['builtin', 'sso', 'none'];
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const COOKIE_SAMESITE_VALUES: readonly CookieSameSite[] = ['lax', 'none'];

/** 是否为本机回环地址（IPv4 / IPv6 / localhost）。 */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '127.0.0.1') return true;
  if (value.startsWith('127.')) return true;
  return false;
}

function parseInteger(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`环境变量 ${name} 必须是 ${min}–${max} 之间的整数，当前为「${raw}」`);
  }
  return value;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`环境变量 ${name} 必须是布尔值（1/0、true/false），当前为「${raw}」`);
}

/**
 * 解析跨域白名单：逗号分隔的精确来源（scheme://host[:port]）。
 * 留空 = 不启用跨域；拒绝 `*`（带 cookie 时浏览器不允许通配），非法来源直接报错。
 * 返回规范化后的 `origin`，去重且保持顺序。
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    if (entry === '*') {
      throw new ConfigError('环境变量 ALLOWED_ORIGINS 不能使用 * 通配（跨域携带 Cookie 时必须列出精确来源）。');
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigError(`环境变量 ALLOWED_ORIGINS 的「${entry}」不是合法来源（需形如 https://app.example.com）。`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConfigError(`环境变量 ALLOWED_ORIGINS 的「${entry}」只支持 http/https 来源。`);
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      throw new ConfigError(`环境变量 ALLOWED_ORIGINS 的「${entry}」只能是来源（scheme://host[:port]），不能带路径或查询）。`);
    }
    const origin = url.origin;
    if (!seen.has(origin)) {
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}

function parseCookieSameSite(raw: string | undefined): CookieSameSite {
  if (raw === undefined || raw.trim() === '') return 'lax';
  const value = raw.trim().toLowerCase();
  if (!(COOKIE_SAMESITE_VALUES as readonly string[]).includes(value)) {
    throw new ConfigError(`环境变量 COOKIE_SAMESITE 只能是 lax / none，当前为「${raw}」`);
  }
  return value as CookieSameSite;
}

/** 解析并校验环境变量；非法配置抛出 `ConfigError`。 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const host = env.HOST === undefined || env.HOST.trim() === '' ? '127.0.0.1' : env.HOST.trim();
  const port = parseInteger('PORT', env.PORT, 18940, 1, 65535);

  const rawAuthMode = env.AUTH_MODE === undefined || env.AUTH_MODE.trim() === '' ? 'builtin' : env.AUTH_MODE.trim();
  if (!(AUTH_MODES as readonly string[]).includes(rawAuthMode)) {
    throw new ConfigError(`环境变量 AUTH_MODE 只能是 builtin / sso / none，当前为「${rawAuthMode}」`);
  }
  const authMode = rawAuthMode as AuthMode;

  const rawLogLevel = env.LOG_LEVEL === undefined || env.LOG_LEVEL.trim() === '' ? 'info' : env.LOG_LEVEL.trim();
  if (!(LOG_LEVELS as readonly string[]).includes(rawLogLevel)) {
    throw new ConfigError(`环境变量 LOG_LEVEL 只能是 debug / info / warn / error，当前为「${rawLogLevel}」`);
  }

  const nodeEnv = env.NODE_ENV === undefined || env.NODE_ENV.trim() === '' ? 'development' : env.NODE_ENV.trim();
  const logLevel = rawLogLevel as LogLevel;

  if (authMode === 'sso' && !isLoopbackHost(host)) {
    throw new ConfigError(
      'AUTH_MODE=sso 时 HOST 必须是回环地址（127.0.0.1 / ::1 / localhost）：SSO 模式只应监听回环，由网关转发并注入 X-Auth-User，否则可被伪造头绕过认证。',
    );
  }
  if (authMode === 'none' && !isLoopbackHost(host) && nodeEnv === 'production') {
    throw new ConfigError(
      'AUTH_MODE=none 仅用于本机开发，生产环境（NODE_ENV=production）且监听非回环地址时拒绝启动。',
    );
  }

  // WebDAV 双向同步（M7）。凭据只从环境变量读取，绝不写日志、绝不返回前端。
  const webdavEnabled = parseBoolean('WEBDAV_ENABLED', env.WEBDAV_ENABLED, false);
  const webdavUrl = env.WEBDAV_URL === undefined ? '' : env.WEBDAV_URL.trim();
  if (webdavEnabled && webdavUrl === '') {
    throw new ConfigError('WEBDAV_ENABLED=1 时必须设置 WEBDAV_URL（WebDAV 目录地址）。');
  }
  const webdavIntervalMinutes = parseInteger('WEBDAV_INTERVAL_MINUTES', env.WEBDAV_INTERVAL_MINUTES, 10, 1, 1440);
  const webdavDebounceSeconds = parseInteger('WEBDAV_DEBOUNCE_SECONDS', env.WEBDAV_DEBOUNCE_SECONDS, 60, 0, 86_400);
  const webdavEncrypt = parseBoolean('WEBDAV_ENCRYPT', env.WEBDAV_ENCRYPT, true);
  const webdavKeep = parseInteger('WEBDAV_KEEP', env.WEBDAV_KEEP, 10, 1, 1000);
  const webdavTimeoutSeconds = parseInteger('WEBDAV_TIMEOUT_SECONDS', env.WEBDAV_TIMEOUT_SECONDS, 20, 1, 600);

  // 前后端分离部署（M10 §2）：CORS 白名单与会话 Cookie 策略。
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const cookieSameSite = parseCookieSameSite(env.COOKIE_SAMESITE);

  return {
    host,
    port,
    dataDir: env.DATA_DIR === undefined || env.DATA_DIR.trim() === '' ? './server/data' : env.DATA_DIR.trim(),
    authMode,
    authUser: env.AUTH_USER === undefined || env.AUTH_USER.trim() === '' ? 'admin' : env.AUTH_USER.trim(),
    authPassword: env.AUTH_PASSWORD ?? '',
    sessionTtlDays: parseInteger('SESSION_TTL_DAYS', env.SESSION_TTL_DAYS, 30, 1, 3650),
    loginRateLimit: parseInteger('LOGIN_RATE_LIMIT', env.LOGIN_RATE_LIMIT, 5, 1, 1000),
    trustProxy: parseBoolean('TRUST_PROXY', env.TRUST_PROXY, true),
    serveStatic: parseBoolean('SERVE_STATIC', env.SERVE_STATIC, true),
    logLevel,
    nodeEnv,
    staticDir: resolve(process.cwd(), 'dist'),
    webdavEnabled,
    webdavUrl,
    webdavUsername: env.WEBDAV_USERNAME ?? '',
    webdavPassword: env.WEBDAV_PASSWORD ?? '',
    webdavIntervalMinutes,
    webdavDebounceSeconds,
    webdavEncrypt,
    webdavKeep,
    webdavTimeoutSeconds,
    allowedOrigins,
    cookieSameSite,
  };
}

/** 启动摘要（不含任何敏感值）。 */
export function describeConfig(config: Config): string {
  return [
    `监听 http://${config.host}:${config.port}`,
    `认证模式 ${config.authMode}`,
    `数据目录 ${config.dataDir}`,
    `静态文件 ${config.serveStatic ? config.staticDir : '关闭'}`,
    `WebDAV ${config.webdavEnabled ? `同步到 ${config.webdavUrl}` : '关闭'}`,
    `CORS ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(',') : '关闭'}`,
  ].join(' | ');
}
