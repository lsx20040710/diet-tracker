import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../electron/database';
import type { DietPlan, MealRatios } from '../src/types/models';

describe('餐次推荐、动态扣减与放纵餐', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let service: DatabaseService;
  let foodId: number;

  function configureActivePlan(mealRatios: MealRatios = { breakfast: 4, lunch: 3, dinner: 3 }) {
    const plan = service.listDietPlans().find((candidate) => candidate.isActive) as DietPlan;
    return service.updateDietPlan(plan.id, {
      name: plan.name,
      goalType: '自定义',
      targetCalories: 1_000,
      targetProtein: 100,
      targetCarbs: 100,
      targetFat: 100,
      calculationMode: 'manual',
      mealRatios,
      startDate: plan.startDate,
      endDate: plan.endDate,
      note: plan.note,
    });
  }

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'diet-tracker-recommendation-test-'));
    databasePath = join(temporaryDirectory, 'diet-tracker.db');
    service = new DatabaseService(databasePath, '0.7.0-test');
    service.initialize();
    configureActivePlan();
    foodId = service.createFood({
      name: '等比例测试食物',
      category: '主食',
      caloriesPer100g: 100,
      proteinPer100g: 10,
      carbsPer100g: 10,
      fatPer100g: 10,
      unitName: '份',
    }).id;
  });

  afterEach(() => {
    service.close();
    rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });

  it('推荐记录随本餐后续手动项缩减，目标耗尽时自动移除', () => {
    const date = '2026-08-20';
    const recommended = service.createMealRecord({
      recordDate: date,
      mealType: 'breakfast',
      foodId,
      amount: 1,
      unitType: 'gram',
      amountMode: 'recommended',
    });
    expect(recommended).toMatchObject({
      amount: 400,
      amountMode: 'recommended',
      recommendationMetric: 'calories',
    });

    const manual = service.createMealRecord({
      recordDate: date,
      mealType: 'breakfast',
      foodId,
      amount: 100,
      unitType: 'gram',
    });
    expect(
      service.getDashboard(date).meals.breakfast.find((record) => record.id === recommended.id),
    ).toMatchObject({ amount: 300, calories: 300 });

    service.updateMealRecord({ id: manual.id, amount: 200, unitType: 'gram' });
    expect(
      service.getDashboard(date).meals.breakfast.find((record) => record.id === recommended.id),
    ).toMatchObject({ amount: 200, calories: 200 });

    service.createMealRecord({
      recordDate: date,
      mealType: 'breakfast',
      foodId,
      amount: 300,
      unitType: 'gram',
    });
    expect(
      service.getDashboard(date).meals.breakfast.some((record) => record.id === recommended.id),
    ).toBe(false);
  });

  it('早餐和午餐超额依次压缩后续餐次目标', () => {
    const date = '2026-08-21';
    service.createMealRecord({
      recordDate: date,
      mealType: 'breakfast',
      foodId,
      amount: 500,
      unitType: 'gram',
    });
    expect(service.getDashboard(date).mealAllocation.meals.lunch.target).toEqual({
      calories: 200,
      protein: 20,
      carbs: 20,
      fat: 20,
    });

    service.createMealRecord({
      recordDate: date,
      mealType: 'lunch',
      foodId,
      amount: 250,
      unitType: 'gram',
    });
    expect(service.getDashboard(date).mealAllocation.meals.dinner.target).toEqual({
      calories: 250,
      protein: 25,
      carbs: 25,
      fat: 25,
    });
  });

  it('加餐固定从当时尚未记录的第一餐扣除，后续记录不会改变归属', () => {
    const date = '2026-08-22';
    service.createMealRecord({
      recordDate: date,
      mealType: 'breakfast',
      foodId,
      amount: 10,
      unitType: 'gram',
    });
    service.createMealRecord({
      recordDate: date,
      mealType: 'snack',
      foodId,
      amount: 100,
      unitType: 'gram',
    });
    expect(service.getDashboard(date).mealAllocation).toMatchObject({
      snack: { deductedFrom: 'lunch' },
      meals: { lunch: { target: { calories: 200, protein: 20, carbs: 20, fat: 20 } } },
    });

    service.createMealRecord({
      recordDate: date,
      mealType: 'lunch',
      foodId,
      amount: 10,
      unitType: 'gram',
    });
    expect(service.getDashboard(date).mealAllocation.snack.deductedFrom).toBe('lunch');
  });

  it('放纵餐清除食物明细并按动态目标记满，前餐变化后同步调整', () => {
    const date = '2026-08-23';
    const breakfast = service.createMealRecord({
      recordDate: date,
      mealType: 'breakfast',
      foodId,
      amount: 500,
      unitType: 'gram',
    });
    service.setMealIndulgence({ recordDate: date, mealType: 'lunch', enabled: true });
    expect(service.getDashboard(date).meals.lunch).toEqual([
      expect.objectContaining({
        foodNameSnapshot: '放纵餐',
        amountMode: 'indulgence',
        calories: 200,
        protein: 20,
        carbs: 20,
        fat: 20,
      }),
    ]);
    expect(() =>
      service.createMealRecord({
        recordDate: date,
        mealType: 'lunch',
        foodId,
        amount: 10,
        unitType: 'gram',
      }),
    ).toThrow('该餐已设为放纵餐');

    service.updateMealRecord({ id: breakfast.id, amount: 600, unitType: 'gram' });
    expect(service.getDashboard(date).meals.lunch[0]).toMatchObject({
      calories: 100,
      protein: 10,
      carbs: 10,
      fat: 10,
    });

    service.setMealIndulgence({ recordDate: date, mealType: 'lunch', enabled: false });
    expect(service.getDashboard(date).meals.lunch).toEqual([]);
  });

  it('餐次比例随每日方案快照保存，后续修改不会改写历史日期', () => {
    const historicalDate = '2026-08-19';
    service.createMealRecord({
      recordDate: historicalDate,
      mealType: 'breakfast',
      foodId,
      amount: 10,
      unitType: 'gram',
    });
    configureActivePlan({ breakfast: 5, lunch: 3, dinner: 2 });

    expect(service.getDashboard(historicalDate).mealAllocation.mealRatios).toEqual({
      breakfast: 4,
      lunch: 3,
      dinner: 3,
    });
    const newDate = '2026-08-24';
    service.createMealRecord({
      recordDate: newDate,
      mealType: 'breakfast',
      foodId,
      amount: 10,
      unitType: 'gram',
    });
    expect(service.getDashboard(newDate).mealAllocation.mealRatios).toEqual({
      breakfast: 5,
      lunch: 3,
      dinner: 2,
    });
  });
});
