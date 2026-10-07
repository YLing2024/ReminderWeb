import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateAppLockSettings, migrateLegacyWebDavSettings } from './storage';

describe('DEFAULT_SETTINGS 默认值', () => {
  it('默认主题色板对齐上游（首启动为蓝色系）', () => {
    expect(DEFAULT_SETTINGS.themeColorPalette).toBe('BLUE');
    expect(DEFAULT_SETTINGS.dynamicColorEnabled).toBe(true);
  });

  it('默认未开启应用锁、无密码凭据', () => {
    expect(DEFAULT_SETTINGS.appLockEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.appLockPasswordHash).toBeNull();
  });
});

describe('migrateAppLockSettings（旧 PIN 字段兼容）', () => {
  it('把旧 appLockPinHash 搬运到 appLockPasswordHash 并删除旧键', () => {
    const legacy = 'a'.repeat(64);
    const migrated = migrateAppLockSettings({ appLockEnabled: true, appLockPinHash: legacy });
    expect(migrated.appLockPasswordHash).toBe(legacy);
    expect('appLockPinHash' in migrated).toBe(false);
    expect(migrated.appLockEnabled).toBe(true);
  });

  it('已有新字段时不覆盖，其余设置原样保留', () => {
    const migrated = migrateAppLockSettings({
      themeOption: 'DARK',
      appLockPasswordHash: { v: 2, algo: 'PBKDF2-SHA-256', salt: 's', iterations: 210_000, hash: 'h' },
      appLockPinHash: 'b'.repeat(64),
    });
    expect(migrated.appLockPasswordHash).toEqual({
      v: 2,
      algo: 'PBKDF2-SHA-256',
      salt: 's',
      iterations: 210_000,
      hash: 'h',
    });
    expect('appLockPinHash' in migrated).toBe(false);
    expect(migrated.themeOption).toBe('DARK');
  });

  it('两字段冲突且新字段无法识别时，回退到旧的可校验摘要', () => {
    const legacy = 'c'.repeat(64);
    const migrated = migrateAppLockSettings({
      appLockPasswordHash: { broken: true },
      appLockPinHash: legacy,
    });
    expect(migrated.appLockPasswordHash).toBe(legacy);
    expect('appLockPinHash' in migrated).toBe(false);
  });
});

describe('migrateLegacyWebDavSettings（M7 凭据迁移到服务端）', () => {
  it('清空浏览器遗留的地址/用户名/口令并标记已迁移', () => {
    const result = migrateLegacyWebDavSettings({
      webdavServer: 'https://dav.example.com/reminder/',
      webdavUsername: 'davuser',
      webdavPassword: 'secret-token',
      themeOption: 'DARK',
    });
    expect(result.migrated).toBe(true);
    expect(result.settings.webdavServer).toBe('');
    expect(result.settings.webdavUsername).toBe('');
    expect(result.settings.webdavPassword).toBe('');
    expect(result.settings.themeOption).toBe('DARK');
    expect(JSON.stringify(result.settings)).not.toContain('secret-token');
  });

  it('没有遗留凭据时不标记迁移', () => {
    const result = migrateLegacyWebDavSettings({ themeOption: 'LIGHT' });
    expect(result.migrated).toBe(false);
    expect(result.settings.themeOption).toBe('LIGHT');
  });
});
