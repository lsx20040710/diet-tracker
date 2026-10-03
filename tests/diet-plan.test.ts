import { describe, expect, it } from 'vitest';

import { calculateWeightBasedPlan } from '../src/utils/diet-plan';

describe('按体重系数生成饮食目标', () => {
  it('按默认碳水三倍、蛋白质两倍、脂肪一倍生成目标和热量', () => {
    expect(
      calculateWeightBasedPlan({
        weight: 70,
        proteinPerKg: 2,
        carbsPerKg: 3,
        fatPerKg: 1,
      }),
    ).toEqual({
      calories: 2030,
      protein: 140,
      carbs: 210,
      fat: 70,
    });
  });

  it('自定义小数系数时保留四位计算精度并按 4/4/9 换算热量', () => {
    expect(
      calculateWeightBasedPlan({
        weight: 69.85,
        proteinPerKg: 2.2,
        carbsPerKg: 3.1,
        fatPerKg: 0.8,
      }),
    ).toEqual({
      calories: 1983.74,
      protein: 153.67,
      carbs: 216.535,
      fat: 55.88,
    });
  });

  it('热量使用未舍入宏量计算，避免累计三次中间舍入误差', () => {
    expect(
      calculateWeightBasedPlan({
        weight: 40.01,
        proteinPerKg: 1,
        carbsPerKg: 1.0123,
        fatPerKg: 0.5679,
      }),
    ).toEqual({
      calories: 526.5436,
      protein: 40.01,
      carbs: 40.5021,
      fat: 22.7217,
    });
  });

  it('允许用户把某项系数设为零', () => {
    expect(
      calculateWeightBasedPlan({
        weight: 60,
        proteinPerKg: 2,
        carbsPerKg: 0,
        fatPerKg: 1,
      }),
    ).toEqual({
      calories: 1020,
      protein: 120,
      carbs: 0,
      fat: 60,
    });
  });

  it.each([
    ['体重为零', { weight: 0, proteinPerKg: 2, carbsPerKg: 3, fatPerKg: 1 }],
    ['体重超过上限', { weight: 1_000.1, proteinPerKg: 2, carbsPerKg: 3, fatPerKg: 1 }],
    ['体重不是有限数', { weight: Number.NaN, proteinPerKg: 2, carbsPerKg: 3, fatPerKg: 1 }],
    ['系数为负数', { weight: 70, proteinPerKg: -1, carbsPerKg: 3, fatPerKg: 1 }],
    ['系数超过上限', { weight: 70, proteinPerKg: 2, carbsPerKg: 20.1, fatPerKg: 1 }],
    ['系数不是有限数', { weight: 70, proteinPerKg: 2, carbsPerKg: 3, fatPerKg: Infinity }],
  ])('%s时拒绝生成', (_name, input) => {
    expect(() => calculateWeightBasedPlan(input)).toThrow();
  });
});
