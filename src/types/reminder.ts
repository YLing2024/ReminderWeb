/**
 * 与安卓端备份 JSON 逐字对齐的数据模型（需求 §3）。
 *
 * 字段名即备份 JSON 的 key，大小写与拼写不得改动。
 * 安卓结构体里还有一批「液态玻璃 / 光栅玻璃」几何参数（AGSL 着色器效果），
 * Web 端不实现视觉，但必须原样保留，因此这里以可选字段声明；索引签名兜底
 * 捕获未来新增的未知字段，保证导入 → 导出不丢数据。
 */

export type ReminderType = 'ANNUAL' | 'COUNT_UP' | 'BIRTHDAY';
export type RepeatUnit = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
export type ReminderMethod = 'APP_NOTIFICATION' | 'SYSTEM_CALENDAR' | 'BOTH';

export interface NotificationTime {
  daysBefore: number;
  time: string; // "HH:mm:ss"
}

export interface ReminderNotificationConfig {
  isEnabled: boolean;
  useAppNotification: boolean;
  useSystemCalendar: boolean;
  isContinuous: boolean;
  includeStartDay: boolean;
  notificationTimes: NotificationTime[];
}

export interface RepeatInfo {
  interval: number;
  unit: RepeatUnit;
  endDate: string | null; // "YYYY-MM-DD"
}

export interface ReminderItem {
  id: number;
  title: string;
  date: string;
  endDate: string | null;
  type: ReminderType;
  isLunar: boolean;
  tag: string;
  isPinned: boolean;
  repeatInfo: RepeatInfo | null;
  notificationConfig: ReminderNotificationConfig;
  notes: string;
  isCustomized: boolean;
  customHeaderColor: string;
  customFont: string;
  cardBackgroundType: string; // "DEFAULT" | "IMAGE" | "COLOR"
  cardBackgroundColor: string;
  cardBackgroundImagePath: string;
  cardBackgroundBlurRadius: number;
  cardBackgroundGlassEnabled: boolean;
  cardBackgroundGlassFrosted: boolean;
  cardBackgroundGlassDensity: number;
  cardBackgroundTextColor: string; // "" | "WHITE" | "BLACK"
  customFontEffect: string; // "AUTO" | "SOLID" | "MIXED"
  customFontColor: string;
  customFontOpacity: number;
  customFontBlur: number;
  customFontWeight: number;
  customFontShadowEnabled: boolean;
  customFontStrokeEnabled: boolean;
  customFontStrokeColor: string;

  /* --- 以下为安卓端液态/光栅玻璃参数：Web 不实现，导入导出原样保留 --- */
  cardBackgroundGlassRefraction?: number;
  cardBackgroundGlassTransparency?: number;
  cardBackgroundGlassBlur?: number;
  customFontGlassRefraction?: number;
  customFontGlassTransparency?: number;
  customFontGlassBlur?: number;
  customFontGlassTheme?: string;
  customGlassBlur?: number;
  customGlassDensity?: number;
  customGlassRefraction?: number;
  customGlassHighlight?: number;

  /** 兜底：安卓端未来新增的未知字段 */
  [key: string]: unknown;
}

export interface TagItem {
  id: number;
  name: string;
  color: string; // "#2196F3"
  sortOrder: number;
}

export interface BackupData {
  reminders: ReminderItem[];
  tags: TagItem[] | null;
  themeOption: 'SYSTEM' | 'LIGHT' | 'DARK' | null;
  pureBlackEnabled: boolean | null;
  cardColoringEnabled: boolean | null;
  defaultPage: 'COUNTDOWN' | 'COUNTUP' | 'BIRTHDAY' | null;
  viewMode: string | null;
  backupReminderEnabled: boolean | null;
  webDavServer: string | null;
  webDavUsername: string | null;
  webDavPassword: string | null;
  webDavPath: string | null;
  dynamicColorEnabled: boolean | null;
  themeColorPalette: 'BLUE' | 'GREEN' | 'YELLOW' | 'ORANGE' | 'PURPLE' | 'PINK' | 'CYAN' | 'MONOCHROME' | null;
  customColorSeed: number | null;
  scrollBehavior: string | null;
  homeCategoryEnabled: boolean | null;
  cardBackgroundImages: Record<string, string> | null; // 文件名 -> base64
}

export const DEFAULT_NOTIFICATION_CONFIG: ReminderNotificationConfig = {
  isEnabled: false,
  useAppNotification: true,
  useSystemCalendar: false,
  isContinuous: false,
  includeStartDay: true,
  notificationTimes: [],
};

/** 生日默认按年重复（上游生日即年度事件）；新增/切换为生日的默认值。 */
export const BIRTHDAY_REPEAT: RepeatInfo = { interval: 1, unit: 'YEAR', endDate: null };

/** 按上游默认值构造一个新提醒（id 由 store 分配）。 */
export function createReminderItem(partial: Pick<ReminderItem, 'title' | 'date' | 'type'> & Partial<ReminderItem>): ReminderItem {
  const item: ReminderItem = {
    id: 0,
    endDate: null,
    isLunar: false,
    tag: '',
    isPinned: false,
    repeatInfo: null,
    notificationConfig: { ...DEFAULT_NOTIFICATION_CONFIG },
    notes: '',
    isCustomized: false,
    customHeaderColor: '',
    customFont: '',
    cardBackgroundType: 'DEFAULT',
    cardBackgroundColor: '',
    cardBackgroundImagePath: '',
    cardBackgroundBlurRadius: 0,
    cardBackgroundGlassEnabled: false,
    cardBackgroundGlassFrosted: false,
    cardBackgroundGlassDensity: 0.5,
    cardBackgroundTextColor: '',
    customFontEffect: 'AUTO',
    customFontColor: '',
    customFontOpacity: 1,
    customFontBlur: 8,
    customFontWeight: 700,
    customFontShadowEnabled: false,
    customFontStrokeEnabled: false,
    customFontStrokeColor: '',
    ...partial,
  };
  // 新增生日（且调用方未显式指定重复）时自动补「每 1 年」。
  if (item.type === 'BIRTHDAY' && item.repeatInfo === null && partial.repeatInfo === undefined) {
    item.repeatInfo = { ...BIRTHDAY_REPEAT };
  }
  return item;
}
