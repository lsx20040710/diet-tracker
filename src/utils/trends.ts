import type { DateRangeQuery, TrendDataPoint } from '../types/models';
import { isValidDateString, shiftDate, todayString, toLocalDateString } from './date';

export const TREND_RANGE_PRESETS = ['7d', '30d', '90d', 'month', 'year', 'custom'] as const;
export type TrendRangePreset = (typeof TREND_RANGE_PRESETS)[number];

export const MOVING_AVERAGE_WINDOWS = [7, 14, 30] as const;
export type MovingAverageWindow = (typeof MOVING_AVERAGE_WINDOWS)[number];

export interface TrendPointWithAverages extends TrendDataPoint {
  weightMovingAverage: number | null;
  bodyFatMovingAverage: number | null;
  waistMovingAverage: number | null;
}

export interface WeeklyAveragePoint {
  recordDate: string;
  weekLabel: string;
  weight: number | null;
  calories: number | null;
}

function dateOrdinal(dateString: string): number {
  const [year, month, day] = dateString.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  // 图表与对应 CSV 共用该结果，稳定到四位小数可避免导出浮点尾差。
  const result = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.round((result + Number.EPSILON) * 10_000) / 10_000;
}

/** 根据本地日期生成图表查询范围，首尾日期均包含在内。 */
export function resolveTrendDateRange(
  preset: TrendRangePreset,
  customStartDate = '',
  customEndDate = '',
  today = todayString(),
): DateRangeQuery | null {
  if (!isValidDateString(today)) return null;

  if (preset === 'custom') {
    if (!isValidDateString(customStartDate) || !isValidDateString(customEndDate)) return null;
    if (customStartDate > customEndDate) return null;
    return { startDate: customStartDate, endDate: customEndDate };
  }

  if (preset === 'month') {
    return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
  }
  if (preset === 'year') {
    return { startDate: `${today.slice(0, 4)}-01-01`, endDate: today };
  }

  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  return { startDate: shiftDate(today, -(days - 1)), endDate: today };
}

/** 为图表补齐自然日索引；空日期保留 null，便于范围切换和跨空日期连线。 */
export function fillTrendDateRange(
  points: readonly TrendDataPoint[],
  query: DateRangeQuery,
): TrendDataPoint[] {
  const sorted = [...points].sort((left, right) => left.recordDate.localeCompare(right.recordDate));
  if (
    !query.startDate ||
    !query.endDate ||
    !isValidDateString(query.startDate) ||
    !isValidDateString(query.endDate) ||
    query.startDate > query.endDate
  ) {
    return sorted;
  }

  const pointsByDate = new Map(sorted.map((point) => [point.recordDate, point]));
  const filled: TrendDataPoint[] = [];
  for (let date = query.startDate; date <= query.endDate; date = shiftDate(date, 1)) {
    filled.push(
      pointsByDate.get(date) ?? {
        recordDate: date,
        weight: null,
        bodyFatPercentage: null,
        waistCircumference: null,
        calories: null,
        protein: null,
        carbs: null,
        fat: null,
        target: null,
      },
    );
  }
  return filled;
}

/**
 * 按自然日窗口计算身体指标移动平均；原值缺失时平均值仍保持 null，避免补造数据点。
 */
export function calculateMovingAverages(
  points: readonly TrendDataPoint[],
  windowDays: MovingAverageWindow,
): TrendPointWithAverages[] {
  const sorted = [...points].sort((left, right) => left.recordDate.localeCompare(right.recordDate));

  return sorted.map((point, index) => {
    const currentOrdinal = dateOrdinal(point.recordDate);
    const windowStart = currentOrdinal - windowDays + 1;
    const windowPoints = sorted.slice(0, index + 1).filter((candidate) => {
      const ordinal = dateOrdinal(candidate.recordDate);
      return ordinal >= windowStart && ordinal <= currentOrdinal;
    });

    const valuesFor = (key: 'weight' | 'bodyFatPercentage' | 'waistCircumference'): number[] =>
      windowPoints.flatMap((candidate) => {
        const value = candidate[key];
        return value === null ? [] : [value];
      });

    return {
      ...point,
      weightMovingAverage: point.weight === null ? null : average(valuesFor('weight')),
      bodyFatMovingAverage:
        point.bodyFatPercentage === null ? null : average(valuesFor('bodyFatPercentage')),
      waistMovingAverage:
        point.waistCircumference === null ? null : average(valuesFor('waistCircumference')),
    };
  });
}

function mondayOfWeek(dateString: string): string {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return toLocalDateString(date);
}

/** 按周一分组，只对真实存在的数值求平均，缺失字段不按 0 参与计算。 */
export function calculateWeeklyAverages(points: readonly TrendDataPoint[]): WeeklyAveragePoint[] {
  const groups = new Map<string, { weights: number[]; calories: number[]; weekLabel: string }>();

  for (const point of [...points].sort((left, right) =>
    left.recordDate.localeCompare(right.recordDate),
  )) {
    const weekStart = mondayOfWeek(point.recordDate);
    const group = groups.get(weekStart) ?? {
      weights: [],
      calories: [],
      weekLabel: `${weekStart.slice(5)} 起`,
    };
    if (point.weight !== null) group.weights.push(point.weight);
    if (point.calories !== null) group.calories.push(point.calories);
    groups.set(weekStart, group);
  }

  return [...groups.entries()].map(([recordDate, group]) => ({
    recordDate,
    weekLabel: group.weekLabel,
    weight: average(group.weights),
    calories: average(group.calories),
  }));
}
