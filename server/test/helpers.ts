/**
 * 测试辅助：内存 SQLite + 端口 0 的临时 HTTP 服务。
 */
import type { AddressInfo, Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { createRateLimiter, ensureInitialUser } from '../src/auth.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDatabaseAt } from '../src/db.ts';
import { createAppServer } from '../src/http.ts';
import type { Logger } from '../src/log.ts';
import type { SyncEngine } from '../src/sync.ts';

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const FIXTURE_DIST = `${process.cwd()}/server/test/fixtures/dist`;

export interface TestServer {
  url: string;
  db: DatabaseSync;
  server: Server;
  close(): Promise<void>;
}

export interface StartOptions {
  env?: Record<string, string | undefined>;
  staticDir?: string;
  /** 建库后的额外初始化（例如建用户）。 */
  setup?: (db: DatabaseSync) => void;
  now?: () => number;
  /** 注入 WebDAV 同步引擎（测试用）。 */
  sync?: SyncEngine | null;
  /** 注入日志器（测试用），用于断言不打印敏感值。 */
  logger?: Logger;
  /** 用已建好的 db 与解析后的 config 构造同步引擎（测试用）。 */
  syncFactory?: (db: DatabaseSync, config: Config) => SyncEngine | null;
}

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const config: Config = loadConfig({
    AUTH_MODE: 'none',
    SERVE_STATIC: '0',
    LOG_LEVEL: 'error',
    ...options.env,
  });
  if (options.staticDir !== undefined) config.staticDir = options.staticDir;
  const db = openDatabaseAt(':memory:');
  options.setup?.(db);
  const rateLimiter = createRateLimiter({ limit: config.loginRateLimit });
  const sync = options.syncFactory !== undefined ? options.syncFactory(db, config) : (options.sync ?? null);
  const server = createAppServer({ config, db, rateLimiter, logger: options.logger ?? silentLogger, now: options.now, sync });
  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    db,
    server,
    close() {
      return new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    },
  };
}

/** 建 builtin 用户。 */
export function seedUser(db: DatabaseSync, username = 'admin', password = 'secret'): void {
  ensureInitialUser(db, username, password, 1_000);
}

/** 从 Set-Cookie 头提取会话 Cookie 名=值。 */
export function sessionCookieFrom(response: Response): string {
  const raw = response.headers.get('set-cookie');
  if (raw === null) return '';
  return raw.split(';')[0] ?? '';
}
