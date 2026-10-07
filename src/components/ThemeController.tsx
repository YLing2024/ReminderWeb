import { useEffect, useState } from 'react';
import { applyTheme } from '../lib/theme';
import { useReminderStore } from '../store/useReminderStore';

function prefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 把当前设置（主题三态 / 纯黑 / 卡片着色 / 种子色）应用到文档根元素。
 * 无副产物渲染；SSR 安全（effect 不在服务端运行）。
 */
export function ThemeController() {
  const settings = useReminderStore((state) => state.settings);
  const [systemDark, setSystemDark] = useState(prefersDark);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const dark =
      settings.themeOption === 'DARK' || (settings.themeOption === 'SYSTEM' && systemDark);
    applyTheme(document.documentElement, settings, dark);
  }, [settings, systemDark]);

  return null;
}
