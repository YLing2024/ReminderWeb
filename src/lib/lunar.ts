/**
 * lunar-javascript（6tail，与安卓端 tyme4kt 同源生态）的最小封装。
 *
 * 农历月用负数表示闰月（与 lunar-javascript / tyme 一致）：
 * 例如 2023 年闰二月 → month = -2。
 */
import { Lunar, LunarMonth, LunarYear, Solar } from 'lunar-javascript';
import { ld, toISODate, type LocalDate } from './local-date';

export interface LunarDate {
  readonly year: number;
  readonly month: number; // 负数表示闰月
  readonly day: number;
}

export function solarToLunar(date: LocalDate): LunarDate {
  const lunar = Solar.fromYmd(date.year, date.month, date.day).getLunar();
  return { year: lunar.getYear(), month: lunar.getMonth(), day: lunar.getDay() };
}

export function lunarToSolar(value: LunarDate): LocalDate {
  const solar = Lunar.fromYmd(value.year, value.month, value.day).getSolar();
  return ld(solar.getYear(), solar.getMonth(), solar.getDay());
}

/** 目标农历月是否在给定年份存在（用于闰月「无闰过前」逻辑）。 */
export function lunarMonthExists(year: number, month: number): boolean {
  try {
    LunarMonth.fromYm(year, month);
    return true;
  } catch {
    return false;
  }
}

/** 农历日是否存在（日号超出该月天数时返回 false）。 */
export function lunarDayExists(year: number, month: number, day: number): boolean {
  try {
    Lunar.fromYmd(year, month, day);
    return true;
  } catch {
    return false;
  }
}

/** 农历月前进 amount 个月（可能跨越闰月），返回 {year, month}。 */
export function nextLunarMonth(year: number, month: number, amount: number): { year: number; month: number } {
  const next = LunarMonth.fromYm(year, month).next(amount);
  return { year: next.getYear(), month: next.getMonth() };
}

export function lunarYearGanZhi(year: number): string {
  // 以该农历年正月初一为代表日取干支纪年。
  return Lunar.fromYmd(year, 1, 1).getYearInGanZhi();
}

export function lunarYearChinese(year: number): string {
  return Lunar.fromYmd(year, 1, 1).getYearInChinese();
}

/** 农历月名（已做「冬月 / 腊月 / 闰冬月 / 闰腊月」映射），如「七月」「闰二月」「冬月」。 */
export function lunarMonthLabel(lunarYear: number, month: number): string {
  const raw = `${Lunar.fromYmd(lunarYear, month, 1).getMonthInChinese()}月`;
  return mapMonthLabel(raw);
}

function mapMonthLabel(raw: string): string {
  switch (raw) {
    case '十一月':
      return '冬月';
    case '十二月':
      return '腊月';
    case '闰十一月':
      return '闰冬月';
    case '闰十二月':
      return '闰腊月';
    default:
      return raw;
  }
}

export function lunarDayLabel(year: number, month: number, day: number): string {
  return Lunar.fromYmd(year, month, day).getDayInChinese();
}

export interface LunarDisplay {
  year: number;
  month: number;
  day: number;
  ganZhi: string;
  yearChinese: string;
  monthLabel: string;
  dayLabel: string;
}

/** 一次取齐某个公历日对应的农历展示字段（干支纪年、月名、日名）。 */
export function lunarDisplay(date: LocalDate): LunarDisplay {
  const lunar = Solar.fromYmd(date.year, date.month, date.day).getLunar();
  return {
    year: lunar.getYear(),
    month: lunar.getMonth(),
    day: lunar.getDay(),
    ganZhi: lunar.getYearInGanZhi(),
    yearChinese: lunar.getYearInChinese(),
    monthLabel: mapMonthLabel(`${lunar.getMonthInChinese()}月`),
    dayLabel: lunar.getDayInChinese(),
  };
}

export interface LunarMonthOption {
  /** 负数表示闰月。 */
  month: number;
  label: string;
  dayCount: number;
}

/** 某农历年的全部月份（含闰月）。 */
export function lunarMonthsOfYear(lunarYear: number): LunarMonthOption[] {
  return LunarYear.fromYear(lunarYear)
    .getMonthsInYear()
    .map((month) => ({
      month: month.getMonth(),
      label: lunarMonthLabel(month.getYear(), month.getMonth()),
      dayCount: month.getDayCount(),
    }));
}

/** 公立年份对应的农历年（取该年春节所在农历年）。 */
export function lunarYearForSolarYear(solarYear: number): number {
  return solarToLunar(ld(solarYear, 7, 1)).year;
}

export { toISODate };
