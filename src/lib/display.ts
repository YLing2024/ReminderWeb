/**
 * 卡片/详情展示信息（对齐安卓端 reminderDisplayInfo）：
 * 依据类型与区间阶段，给出顶部小标题、超大天数、底部日期带。
 */
import type { ReminderItem } from '../types/reminder';
import { calculateNextTargetDate, formatLunarDate, formatLunarDateShort, resolveIntervalStage } from './calendar';
import { daysBetween, formatGregorianDate, parseLocalDate, type LocalDate } from './local-date';

export interface ReminderDisplayInfo {
  /** 顶部色带文字：`title + 空格 + suffix`（如「事件 生日就是」）。 */
  headerTitle: string;
  suffix: string;
  dayCount: number;
  isToday: boolean;
  /** 底部日期带。 */
  referenceText: string;
  /** 区间事件副标题（共 N 天 · 还剩 M 天），非区间为 null。 */
  intervalSubText: string | null;
}

function formatReferenceDate(date: LocalDate, useLunar: boolean, shortFormat: boolean): string {
  if (useLunar) {
    return shortFormat ? formatLunarDateShort(date) : formatLunarDate(date);
  }
  return formatGregorianDate(date);
}

export function buildHeaderTitle(title: string, suffix: string): string {
  return [title.trim(), suffix.trim()].filter((part) => part.length > 0).join(' ');
}

export function reminderDisplayInfo(
  item: ReminderItem,
  today: LocalDate,
  useLunar: boolean = item.isLunar,
  shortFormat = false,
): ReminderDisplayInfo {
  switch (item.type) {
    case 'ANNUAL': {
      const stage = resolveIntervalStage(item, today);
      if (stage !== null) {
        const periodOffset = daysBetween(parseLocalDate(item.date), parseLocalDate(item.endDate ?? item.date));
        const referenceText = formatReferenceDate(stage.date, useLunar, shortFormat);
        const intervalSubText =
          stage.label === '第'
            ? `共${periodOffset + 1}天 · 还剩${daysBetween(today, stage.date) + 1}天`
            : stage.label === '已过'
              ? null
              : `共${periodOffset + 1}天`;
        return {
          headerTitle: buildHeaderTitle(item.title, stage.label),
          suffix: stage.label,
          dayCount: stage.dayCount,
          isToday: stage.label === '就是',
          referenceText,
          intervalSubText,
        };
      }

      const nextDate = calculateNextTargetDate(item, today);
      if (nextDate === null) {
        return {
          headerTitle: buildHeaderTitle(item.title, '已过'),
          suffix: '已过',
          dayCount: Math.max(0, daysBetween(parseLocalDate(item.date), today)),
          isToday: false,
          referenceText: formatReferenceDate(parseLocalDate(item.date), useLunar, shortFormat),
          intervalSubText: null,
        };
      }

      const daysRemaining = daysBetween(today, nextDate);
      const suffix = daysRemaining === 0 ? '就是' : '还有';
      return {
        headerTitle: buildHeaderTitle(item.title, suffix),
        suffix,
        dayCount: Math.max(0, daysRemaining),
        isToday: daysRemaining === 0,
        referenceText: formatReferenceDate(nextDate, useLunar, shortFormat),
        intervalSubText: null,
      };
    }

    case 'COUNT_UP': {
      const includeStartDay = item.notificationConfig.includeStartDay;
      const daysElapsed =
        Math.max(0, daysBetween(parseLocalDate(item.date), today)) + (includeStartDay ? 1 : 0);
      return {
        headerTitle: buildHeaderTitle(item.title, '第'),
        suffix: '第',
        dayCount: daysElapsed,
        isToday: false,
        referenceText: formatReferenceDate(parseLocalDate(item.date), useLunar, shortFormat),
        intervalSubText: null,
      };
    }

    case 'BIRTHDAY': {
      const nextDate = calculateNextTargetDate(item, today);
      if (nextDate === null) {
        return {
          headerTitle: buildHeaderTitle(item.title, '生日已过'),
          suffix: '生日已过',
          dayCount: Math.max(0, daysBetween(parseLocalDate(item.date), today)),
          isToday: false,
          referenceText: formatReferenceDate(parseLocalDate(item.date), useLunar, shortFormat),
          intervalSubText: null,
        };
      }
      const daysRemaining = daysBetween(today, nextDate);
      const suffix = daysRemaining === 0 ? '生日就是' : '生日还有';
      return {
        headerTitle: buildHeaderTitle(item.title, suffix),
        suffix,
        dayCount: Math.max(0, daysRemaining),
        isToday: daysRemaining === 0,
        referenceText: formatReferenceDate(nextDate, useLunar, shortFormat),
        intervalSubText: null,
      };
    }
  }
}
