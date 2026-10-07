import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { toBackupData, importBackup } from './backup-service';
import { BackupError } from './backup';
import { DEFAULT_SETTINGS } from './storage';
import { makeItem } from '../test/factories';

describe('toBackupData 状态映射', () => {
  it('把本地设置映射为安卓字段名，Web 专有字段单独处理', () => {
    const data = toBackupData([makeItem({ id: 1 })], [], {
      ...DEFAULT_SETTINGS,
      themeOption: 'DARK',
      pureBlackEnabled: true,
      cardColoringEnabled: false,
      homeCategoryEnabled: false,
      defaultPage: 'BIRTHDAY',
      viewMode: 'LIST',
      scrollBehavior: 'NONE',
      dynamicColorEnabled: false,
      themeColorPalette: 'CYAN',
      customColorSeed: 424242,
      backupReminderEnabled: true,
    });
    expect(data).toMatchObject({
      themeOption: 'DARK',
      pureBlackEnabled: true,
      cardColoringEnabled: false,
      homeCategoryEnabled: false,
      defaultPage: 'BIRTHDAY',
      viewMode: 'LIST',
      scrollBehavior: 'NONE',
      dynamicColorEnabled: false,
      themeColorPalette: 'CYAN',
      customColorSeed: 424242,
      backupReminderEnabled: true,
    });
    // Web 不实现 WebDAV，导出置空；图片随 zip 走，不内联。
    expect(data.webDavServer).toBeNull();
    expect(data.cardBackgroundImages).toBeNull();
    expect(data.reminders).toHaveLength(1);
  });
});

describe('importBackup 坏包在写入本地前即失败', () => {
  it('空文件 / 缺 metadata.json / 非 zip 均抛 BackupError', async () => {
    await expect(importBackup(new Uint8Array(0))).rejects.toBeInstanceOf(BackupError);
    const noMetadata = zipSync({ 'images/a.png': strToU8('x') });
    await expect(importBackup(noMetadata)).rejects.toBeInstanceOf(BackupError);
    const random = crypto.getRandomValues(new Uint8Array(64));
    await expect(importBackup(random)).rejects.toBeInstanceOf(BackupError);
  });
});
