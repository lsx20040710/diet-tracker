import { describe, expect, it } from 'vitest';

import {
  calculateNutritionByGrams,
  calculateNutritionByServing,
  calculateProgressPercent,
  createNutritionProgress,
  roundNutrition,
  sumNutrition,
} from '../src/utils/nutrition';
import type { NutritionValues } from '../src/types/models';

const CHICKEN_BREAST_PER_100G: NutritionValues = {
  calories: 165,
  protein: 31,
  carbs: 0,
  fat: 3.6,
};

describe('营养换算', () => {
  it('按照每 100 克数据换算实际食用重量', () => {
    expect(calculateNutritionByGrams(CHICKEN_BREAST_PER_100G, 180)).toEqual({
      calories: 297,
      protein: 55.8,
      carbs: 0,
      fat: 6.48,
    });
  });

  it('按照份数和每份重量换算营养', () => {
    const eggPer100g: NutritionValues = {
      calories: 144,
      protein: 13.3,
      carbs: 2.8,
      fat: 8.8,
    };

    expect(calculateNutritionByServing(eggPer100g, 2, 50)).toEqual(eggPer100g);
    expect(calculateNutritionByServing(eggPer100g, 1.5, 50)).toEqual({
      calories: 108,
      protein: 9.975,
      carbs: 2.1,
      fat: 6.6,
    });
  });

  it.each([
    ['克数为零', () => calculateNutritionByGrams(CHICKEN_BREAST_PER_100G, 0), '食用重量必须大于 0'],
    [
      '克数不是有限数',
      () => calculateNutritionByGrams(CHICKEN_BREAST_PER_100G, Number.NaN),
      '食用重量必须大于 0',
    ],
    [
      '份数为负数',
      () => calculateNutritionByServing(CHICKEN_BREAST_PER_100G, -1, 50),
      '份数必须大于 0',
    ],
    [
      '每份重量为零',
      () => calculateNutritionByServing(CHICKEN_BREAST_PER_100G, 1, 0),
      '该食物没有有效的每份重量',
    ],
  ])('%s时拒绝计算', (_name, action, message) => {
    expect(action).toThrow(message);
  });
});

describe('浮点数精度', () => {
  it('将计算结果稳定保留到四位小数', () => {
    expect(roundNutrition(1.23456)).toBe(1.2346);
    expect(roundNutrition(0.1 + 0.2)).toBe(0.3);

    expect(
      calculateNutritionByGrams(
        { calories: 123.4567, protein: 12.3456, carbs: 23.4567, fat: 3.4567 },
        33.3,
      ),
    ).toEqual({
      calories: 41.1111,
      protein: 4.1111,
      carbs: 7.8111,
      fat: 1.1511,
    });
  });

  it('多条记录累计时不会保留二进制浮点尾差', () => {
    expect(
      sumNutrition([
        { calories: 0.1, protein: 0.1, carbs: 0.1, fat: 0.1 },
        { calories: 0.2, protein: 0.2, carbs: 0.2, fat: 0.2 },
        { calories: 0.3, protein: 0.3, carbs: 0.3, fat: 0.3 },
      ]),
    ).toEqual({ calories: 0.6, protein: 0.6, carbs: 0.6, fat: 0.6 });
  });
});

describe('营养目标进度', () => {
  it('目标为零时避免除零并返回稳定百分比', () => {
    expect(calculateProgressPercent(0, 0)).toBe(0);
    expect(calculateProgressPercent(10, 0)).toBe(100);
    expect(Number.isFinite(calculateProgressPercent(10, 0))).toBe(true);
  });

  it('超过目标时保留负差值供界面显示超出数量', () => {
    const progress = createNutritionProgress(
      { calories: 2120, protein: 155.5, carbs: 180, fat: 71 },
      { calories: 2000, protein: 150, carbs: 200, fat: 65 },
    );

    expect(progress.remaining).toEqual({
      calories: -120,
      protein: -5.5,
      carbs: 20,
      fat: -6,
    });
    expect(calculateProgressPercent(2120, 2000)).toBe(106);
  });
});
