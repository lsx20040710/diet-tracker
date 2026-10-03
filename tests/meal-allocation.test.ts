import { describe, expect, it } from 'vitest';

import {
  calculateDailyMealAllocation,
  calculateRecommendedMealAmount,
  splitNutritionByMealRatios,
} from '../src/utils/meal-allocation';

const zero = { calories: 0, protein: 0, carbs: 0, fat: 0 };

describe('餐次目标分配与摄入量推荐', () => {
  it('按 4:3:3 同时拆分热量和三大营养素', () => {
    expect(
      splitNutritionByMealRatios(
        { calories: 2_000, protein: 150, carbs: 300, fat: 60 },
        { breakfast: 4, lunch: 3, dinner: 3 },
      ),
    ).toEqual({
      breakfast: { calories: 800, protein: 60, carbs: 120, fat: 24 },
      lunch: { calories: 600, protein: 45, carbs: 90, fat: 18 },
      dinner: { calories: 600, protein: 45, carbs: 90, fat: 18 },
    });
  });

  it('前餐超额依次扣减下一餐，并保留继续向晚餐传递的超额', () => {
    const allocation = calculateDailyMealAllocation({
      target: { calories: 1_000, protein: 100, carbs: 100, fat: 100 },
      mealRatios: { breakfast: 4, lunch: 3, dinner: 3 },
      consumedByMeal: {
        breakfast: { calories: 500, protein: 50, carbs: 40, fat: 40 },
        lunch: { calories: 250, protein: 25, carbs: 30, fat: 30 },
        dinner: zero,
      },
      snackConsumed: zero,
      snackDeductedFrom: 'dinner',
    });

    expect(allocation.meals.lunch.target).toEqual({
      calories: 200,
      protein: 20,
      carbs: 30,
      fat: 30,
    });
    expect(allocation.meals.dinner.target).toEqual({
      calories: 250,
      protein: 25,
      carbs: 30,
      fat: 30,
    });
  });

  it('加餐从指定未记录餐次扣减，放纵餐按扣减后的动态目标记满', () => {
    const allocation = calculateDailyMealAllocation({
      target: { calories: 1_000, protein: 100, carbs: 100, fat: 100 },
      mealRatios: { breakfast: 4, lunch: 3, dinner: 3 },
      consumedByMeal: { breakfast: zero, lunch: zero, dinner: zero },
      snackConsumed: { calories: 100, protein: 10, carbs: 5, fat: 2 },
      snackDeductedFrom: 'lunch',
      indulgenceMealTypes: ['lunch'],
    });

    expect(allocation.meals.lunch.target).toEqual({
      calories: 200,
      protein: 20,
      carbs: 25,
      fat: 28,
    });
    expect(allocation.meals.lunch.consumed).toEqual(allocation.meals.lunch.target);
    expect(allocation.meals.dinner.target).toEqual({
      calories: 300,
      protein: 30,
      carbs: 30,
      fat: 30,
    });
  });

  it('推荐摄入量以最先达到的营养项为上限，并按输入精度向下取整', () => {
    expect(
      calculateRecommendedMealAmount({
        nutritionPer100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6 },
        remaining: { calories: 300, protein: 30, carbs: 50, fat: 10 },
        unitType: 'gram',
        servingGrams: null,
        unitName: '份',
      }),
    ).toEqual({ amount: 96.7, limitingMetric: 'protein' });

    expect(
      calculateRecommendedMealAmount({
        nutritionPer100g: { calories: 140, protein: 12, carbs: 1, fat: 9 },
        remaining: { calories: 500, protein: 13, carbs: 30, fat: 30 },
        unitType: 'serving',
        servingGrams: 50,
        unitName: '个',
      }),
    ).toEqual({ amount: 2.1, limitingMetric: 'protein' });
  });
});
