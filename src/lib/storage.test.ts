import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './storage';

describe('DEFAULT_SETTINGS 默认值', () => {
  it('默认主题色板对齐上游（首启动为蓝色系）', () => {
    expect(DEFAULT_SETTINGS.themeColorPalette).toBe('BLUE');
    expect(DEFAULT_SETTINGS.dynamicColorEnabled).toBe(true);
  });
});
