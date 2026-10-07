/**
 * 服务入口：读环境变量 → 建库 → 起 HTTP → 优雅退出。
 *
 * 运行：`node server/src/index.ts`（Node ≥ 24 直接执行 TypeScript，类型擦除）。
 */
import type { Server } from 'node:http';
import { createRateLimiter, ensureInitialUser } from './auth.ts';
import { describeConfig, loadConfig, type Config } from './config.ts';
import { openDatabase } from './db.ts';
import { createAppServer } from './http.ts';
import { createLogger } from './log.ts';
import { SyncEngine } from './sync.ts';

function boot(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`启动失败：${error instanceof Error ? error.message : '配置错误'}`);
    process.exit(1);
    return;
  }

  const logger = createLogger(config.logLevel);
  const db = openDatabase(config.dataDir);

  if (config.authMode === 'builtin') {
    const result = ensureInitialUser(db, config.authUser, config.authPassword);
    if (result.created && result.generatedPassword !== undefined) {
      console.log('='.repeat(64));
      console.log(`已生成一次性初始口令（用户 ${config.authUser}），请立即记录并登录后尽快修改：`);
      console.log(`    ${result.generatedPassword}`);
      console.log('该口令只显示这一次，之后不会再次打印。');
      console.log('='.repeat(64));
    }
  } else if (config.authMode === 'none') {
    console.warn('警告：AUTH_MODE=none 关闭了认证，仅可用于本机开发，切勿部署到公网。');
  }

  const rateLimiter = createRateLimiter({ limit: config.loginRateLimit });
  // 只要配置了目录地址就创建引擎：自动同步开关已迁到库里（M9），
  // 初始开关来自 WEBDAV_ENABLED，之后由界面控制，无需改 env 重启。
  const sync = config.webdavUrl !== '' ? new SyncEngine(config, db, logger) : null;
  const server: Server = createAppServer({ config, db, rateLimiter, logger, sync });
  sync?.start();

  server.on('error', (error: unknown) => {
    logger.error(`服务器错误：${error instanceof Error ? error.message : '未知错误'}`);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    logger.info(`ReminderWeb 服务已启动 | ${describeConfig(config)}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭…`);
    sync?.stop();
    server.close(() => {
      db.close();
      logger.info('已停止。');
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export { boot };

if (import.meta.url === `file://${process.argv[1]}`) {
  boot();
}
