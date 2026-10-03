import { describe, expect, it } from 'vitest';

import type { TrendDataPoint } from '../src/types/models';
import {
  calculateMovingAverages,
  calculateWeeklyAverages,
  fillTrendDateRange,
  resolveTrendDateRange,
} from '../src/utils/trends';

function createTrendPoint(
  recordDate: string,
  overrides: Partial<TrendDataPoint> = {},
): TrendDataPoint {
  return {
    recordDate,
    weight: null,
    bodyFatPercentage: null,
    waistCircumference: null,
    calories: null,
    protein: null,
    carbs: null,
    fat: null,
    target: null,
    ...overrides,
  };
}

describe('趋势图纯函数', () => {
  it('按自然日窗口计算移动平均，缺失值不会作为 0 或虚构数据参与', () => {
    const points = [
      createTrendPoint('2026-08-08', {
        weight: 68,
        bodyFatPercentage: 18,
        waistCircumference: 77,
      }),
      createTrendPoint('2026-08-01', {
        weight: 70,
        bodyFatPercentage: 20,
        waistCircumference: 80,
      }),
      createTrendPoint('2026-08-03', {
        bodyFatPercentage: 19,
        waistCircumference: 79,
      }),
      createTrendPoint('2026-08-07', {
        weight: 69,
        waistCircumference: 78,
      }),
    ];

    const result = calculateMovingAverages(points, 7);

    expect(points.map((point) => point.recordDate)).toEqual([
      '2026-08-08',
      '2026-08-01',
      '2026-08-03',
      '2026-08-07',
    ]);
    expect(result.map((point) => point.recordDate)).toEqual([
      '2026-08-01',
      '2026-08-03',
      '2026-08-07',
      '2026-08-08',
    ]);
    expect(result[1]).toMatchObject({
      weight: null,
      weightMovingAverage: null,
      bodyFatMovingAverage: 19.5,
      waistMovingAverage: 79.5,
    });
    expect(result[3]).toMatchObject({
      weightMovingAverage: 68.5,
      bodyFatMovingAverage: 18.5,
      waistMovingAverage: 78,
    });
  });

  it('周平均只统计真实数值，并让全为空的指标保持 null', () => {
    const result = calculateWeeklyAverages([
      createTrendPoint('2026-08-05', { weight: 69, calories: null }),
      createTrendPoint('2026-08-03', { weight: 71, calories: 1800 }),
      createTrendPoint('2026-08-10', { calories: 2000 }),
    ]);

    expect(result).toEqual([
      {
        recordDate: '2026-08-03',
        weekLabel: '08-03 起',
        weight: 70,
        calories: 1800,
      },
      {
        recordDate: '2026-08-10',
        weekLabel: '08-10 起',
        weight: null,
        calories: 2000,
      },
    ]);
  });

  it('移动平均保留至少四位小数精度，避免浮点累计误差改变边界结果', () => {
    const result = calculateMovingAverages(
      [
        createTrendPoint('2026-08-01', { weight: 70.0001 }),
        createTrendPoint('2026-08-02', { weight: 70.0002 }),
        createTrendPoint('2026-08-03', { weight: 70.0003 }),
      ],
      7,
    );

    expect(result[2].weightMovingAverage).toBeCloseTo(70.0002, 10);
    expect(Math.round((result[2].weightMovingAverage ?? 0) * 10_000) / 10_000).toBe(70.0002);
  });

  it('跳天记录时仍按自然日计算不同移动平均窗口', () => {
    const points = [
      createTrendPoint('2026-08-01', { weight: 70 }),
      createTrendPoint('2026-08-10', { weight: 60 }),
    ];

    expect(calculateMovingAverages(points, 7)[1].weightMovingAverage).toBe(60);
    expect(calculateMovingAverages(points, 30)[1].weightMovingAverage).toBe(65);
  });

  it('为图表补齐时间范围内的空日期，原始记录和空值保持可区分', () => {
    const result = fillTrendDateRange([createTrendPoint('2026-08-03', { weight: 68 })], {
      startDate: '2026-08-01',
      endDate: '2026-08-05',
    });

    expect(result.map((point) => point.recordDate)).toEqual([
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
    expect(result[1]).toMatchObject({
      weight: null,
      calories: null,
      target: null,
    });
    expect(result[2]).toMatchObject({ weight: 68 });
  });

  it('预设与自定义时间范围首尾均包含，并拒绝无效自定义范围', () => {
    expect(resolveTrendDateRange('7d', '', '', '2026-08-10')).toEqual({
      startDate: '2026-08-04',
      endDate: '2026-08-10',
    });
    expect(resolveTrendDateRange('30d', '', '', '2026-08-10')).toEqual({
      startDate: '2026-07-12',
      endDate: '2026-08-10',
    });
    expect(resolveTrendDateRange('month', '', '', '2026-08-10')).toEqual({
      startDate: '2026-08-01',
      endDate: '2026-08-10',
    });
    expect(resolveTrendDateRange('year', '', '', '2026-08-10')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-08-10',
    });
    expect(resolveTrendDateRange('custom', '2026-07-01', '2026-07-31')).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });
    expect(resolveTrendDateRange('custom', '2026-08-02', '2026-08-01')).toBeNull();
    expect(resolveTrendDateRange('custom', '2026-02-30', '2026-03-01')).toBeNull();
  });
});
