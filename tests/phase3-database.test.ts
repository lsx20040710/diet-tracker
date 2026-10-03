import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService, type ImportedFoodRecord } from '../electron/database';
import type { FoodInput } from '../src/types/models';

function createFoodInput(name: string, overrides: Partial<FoodInput> = {}): FoodInput {
  return {
    name,
    category: '其他',
    caloriesPer100g: 100,
    proteinPer100g: 10,
    carbsPer100g: 20,
    fatPer100g: 5,
    defaultServingGrams: 50,
    unitName: '份',
    ...overrides,
  };
}

describe('第三阶段本地数据库', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let service: DatabaseService;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'diet-tracker-phase3-test-'));
    databasePath = join(temporaryDirectory, 'diet-tracker.db');
    service = new DatabaseService(databasePath, '0.3.0-test');
    service.initialize();
  });

  afterEach(() => {
    service.close();
    rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    });
  });

  it('趋势查询返回稀疏日期，身体或餐次缺失的指标保持 null', () => {
    const food = service.createFood(createFoodInput('趋势测试食物'));
    service.upsertBodyRecord({
      recordDate: '2026-08-01',
      weight: 70,
      bodyFatPercentage: 19,
      waistCircumference: 80,
    });
    service.createMealRecord({
      recordDate: '2026-08-03',
      mealType: 'lunch',
      foodId: food.id,
      amount: 100,
      unitType: 'gram',
    });
    service.upsertBodyRecord({ recordDate: '2026-08-05', weight: 69.5 });
    service.createMealRecord({
      recordDate: '2026-08-05',
      mealType: 'dinner',
      foodId: food.id,
      amount: 50,
      unitType: 'gram',
    });
    service.upsertBodyRecord({ recordDate: '2026-07-31', weight: 70.5 });

    const points = service.getTrendData({
      startDate: '2026-08-01',
      endDate: '2026-08-05',
    });

    expect(points.map((point) => point.recordDate)).toEqual([
      '2026-08-01',
      '2026-08-03',
      '2026-08-05',
    ]);
    expect(points[0]).toMatchObject({
      weight: 70,
      bodyFatPercentage: 19,
      waistCircumference: 80,
      calories: null,
      protein: null,
      carbs: null,
      fat: null,
    });
    expect(points[1]).toMatchObject({
      weight: null,
      bodyFatPercentage: null,
      waistCircumference: null,
      calories: 100,
      protein: 10,
      carbs: 20,
      fat: 5,
    });
    expect(points[2]).toMatchObject({
      weight: 69.5,
      calories: 50,
      protein: 5,
      carbs: 10,
      fat: 2.5,
    });
    expect(points.every((point) => point.target !== null)).toBe(true);
  });

  it('身体数据批量导入可区分新增和更新，并在失败时整批回滚', () => {
    service.upsertBodyRecord({ recordDate: '2026-08-01', weight: 70, note: '原记录' });

    const result = service.importBodyRecords([
      { recordDate: '2026-08-01', weight: 69.8, note: '导入覆盖' },
      { recordDate: '2026-08-02', weight: 69.6, bodyFatPercentage: 18.5 },
    ]);
    expect(result).toEqual({ createdCount: 1, updatedCount: 1 });
    expect(service.listBodyRecords()).toEqual([
      expect.objectContaining({ recordDate: '2026-08-02', weight: 69.6 }),
      expect.objectContaining({
        recordDate: '2026-08-01',
        weight: 69.8,
        note: '导入覆盖',
      }),
    ]);

    expect(() =>
      service.importBodyRecords([
        { recordDate: '2026-08-03', weight: 69.4 },
        { recordDate: '2026-08-04', weight: -1 },
      ]),
    ).toThrow();
    expect(service.listBodyRecords().map((record) => record.recordDate)).not.toContain(
      '2026-08-03',
    );
  });

  it('食物批量导入保留布尔字段和停用状态，并在失败时整批回滚', () => {
    const inputs: ImportedFoodRecord[] = [
      {
        input: createFoodInput('CSV 普通食物', {
          brand: '测试品牌',
          isFavorite: true,
          isRecommendable: true,
        }),
        isArchived: false,
      },
      {
        input: createFoodInput('CSV 停用补剂', {
          category: '补剂',
          isSupplement: true,
          countInNutrition: false,
          isRecommendable: false,
        }),
        isArchived: true,
      },
    ];

    expect(service.importFoods(inputs)).toEqual({ createdCount: 2, updatedCount: 0 });
    expect(service.listFoods({ includeArchived: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'CSV 普通食物',
          brand: '测试品牌',
          isFavorite: true,
          isArchived: false,
        }),
        expect.objectContaining({
          name: 'CSV 停用补剂',
          isSupplement: true,
          countInNutrition: false,
          isRecommendable: false,
          isArchived: true,
        }),
      ]),
    );

    expect(() =>
      service.importFoods([
        { input: createFoodInput('回滚前食物'), isArchived: false },
        {
          input: createFoodInput('非法食物', { caloriesPer100g: -1 }),
          isArchived: false,
        },
      ]),
    ).toThrow();
    expect(service.listFoods({ includeArchived: true }).map((food) => food.name)).not.toContain(
      '回滚前食物',
    );
  });
});
