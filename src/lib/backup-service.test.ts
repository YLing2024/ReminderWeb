import { describe, expect, it } from 'vitest';
import { toBackupData } from './backup-service';
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
