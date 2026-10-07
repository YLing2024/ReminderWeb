/**
 * 极简日志：按 LOG_LEVEL 过滤。绝不打印口令 / 令牌 / Cookie 值。
 */
import type { LogLevel } from './config.ts';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];
  return {
    debug(message) {
      if (threshold <= ORDER.debug) console.debug(message);
    },
    info(message) {
      if (threshold <= ORDER.info) console.log(message);
    },
    warn(message) {
      if (threshold <= ORDER.warn) console.warn(message);
    },
    error(message) {
      if (threshold <= ORDER.error) console.error(message);
    },
  };
}
