import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../electron/database';
import { foodInputSchema } from '../electron/ipc/schemas';
import { MEAL_TYPES, type FoodInput } from '../src/types/models';

function createSupplementInput(name: string, overrides: Partial<FoodInput> = {}): FoodInput {
  return {
    name,
    category: '补剂',
    caloriesPer100g: 100,
    proteinPer100g: 10,
    carbsPer100g: 5,
    fatPer100g: 2,
    defaultServingGrams: 10,
    unitName: '份',
    isSupplement: true,
    countInNutrition: true,
    isRecommendable: true,
    supplementFrequency: 'as_needed',
    supplementWeekdays: [],
    supplementDosage: null,
    supplementDosageUnit: 'gram',
    ...overrides,
  };
}

describe('补剂计划与独立记录', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let service: DatabaseService;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'diet-tracker-supplement-test-'));
    databasePath = join(temporaryDirectory, 'diet-tracker.db');
    service = new DatabaseService(databasePath, '0.6.0-test');
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

  it('新数据库使用 v7，并为未设置计划的补剂补齐安全默认值', () => {
    const supplement = service.createFood({
      name: '无计划测试补剂',
      category: '补剂',
      caloriesPer100g: 0,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 0,
    });

    expect(service.getAppInfo().databaseVersion).toBe(10);
    expect(MEAL_TYPES).toContain('supplement');
    expect(supplement).toMatchObject({
      supplementFrequency: 'as_needed',
      supplementWeekdays: [],
      supplementDosage: null,
      supplementDosageUnit: 'gram',
    });
  });

  it('每天与指定星期的补剂仅在到期日期进入推荐，按需补剂不推荐', () => {
    const dailySupplement = service.createFood(
      createSupplementInput('每日测试补剂', {
        supplementFrequency: 'daily',
        supplementDosage: 5,
      }),
    );
    const weekdaySupplement = service.createFood(
      createSupplementInput('星期测试补剂', {
        supplementFrequency: 'weekdays',
        supplementWeekdays: ['monday', 'wednesday'],
        supplementDosage: 2,
        supplementDosageUnit: 'serving',
      }),
    );
    const asNeededSupplement = service.createFood(createSupplementInput('按需测试补剂'));

    const mondayRecommendationIds = service
      .getDashboard('2026-08-24')
      .supplementRecommendations.map((food) => food.id);
    const tuesdayRecommendationIds = service
      .getDashboard('2026-08-25')
      .supplementRecommendations.map((food) => food.id);

    expect(mondayRecommendationIds).toEqual(
      expect.arrayContaining([dailySupplement.id, weekdaySupplement.id]),
    );
    expect(mondayRecommendationIds).toHaveLength(2);
    expect(mondayRecommendationIds).not.toContain(asNeededSupplement.id);
    expect(tuesdayRecommendationIds).toEqual([dailySupplement.id]);
  });

  it('补剂计划和独立记录接受半片，并按实际份量计算营养', () => {
    const supplement = service.createFood(
      createSupplementInput('半片用量测试', {
        unitName: '片',
        supplementFrequency: 'daily',
        supplementDosage: 0.5,
        supplementDosageUnit: 'serving',
      }),
    );
    expect(service.getDashboard('2026-10-03').supplementRecommendations).toContainEqual(
      expect.objectContaining({ id: supplement.id, supplementDosage: 0.5 }),
    );
    const record = service.createMealRecord({
      recordDate: '2026-10-03',
      mealType: 'supplement',
      foodId: supplement.id,
      amount: 0.5,
      unitType: 'serving',
    });
    expect(record).toMatchObject({ amount: 0.5, gramsSnapshot: 5, calories: 5 });
  });

  it('补剂记录进入独立分区并计入营养快照，归档补剂后历史仍保持不变', () => {
    const supplementInput = createSupplementInput('营养快照测试鱼油', {
      caloriesPer100g: 900,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 100,
      defaultServingGrams: 1,
      unitName: '粒',
      supplementFrequency: 'daily',
      supplementDosage: 2,
      supplementDosageUnit: 'serving',
    });
    const supplement = service.createFood(supplementInput);
    const record = service.createMealRecord({
      recordDate: '2026-08-24',
      mealType: 'supplement',
      foodId: supplement.id,
      amount: 2,
      unitType: 'serving',
    });

    expect(record).toMatchObject({
      mealType: 'supplement',
      foodNameSnapshot: '营养快照测试鱼油',
      gramsSnapshot: 2,
      calories: 18,
      fat: 2,
      countInNutritionSnapshot: true,
    });

    service.updateFood(supplement.id, {
      ...supplementInput,
      caloriesPer100g: 0,
      fatPer100g: 0,
    });
    service.archiveFood(supplement.id);

    const dashboard = service.getDashboard('2026-08-24');
    expect(dashboard.meals.breakfast).toEqual([]);
    expect(dashboard.meals.lunch).toEqual([]);
    expect(dashboard.meals.dinner).toEqual([]);
    expect(dashboard.meals.snack).toEqual([]);
    expect(dashboard.meals.supplement).toEqual([
      expect.objectContaining({
        id: record.id,
        calories: 18,
        fat: 2,
        countInNutritionSnapshot: true,
      }),
    ]);
    expect(dashboard.nutrition.consumed).toEqual({
      calories: 18,
      protein: 0,
      carbs: 0,
      fat: 2,
    });
    expect(dashboard.supplementRecommendations.map((food) => food.id)).not.toContain(supplement.id);
  });

  it('补剂计划校验拒绝缺少用量、缺少星期以及按份却未填写每份重量', () => {
    const validDailyInput = createSupplementInput('合法每日补剂', {
      supplementFrequency: 'daily',
      supplementDosage: 5,
    });
    const validWeekdayInput = createSupplementInput('合法星期补剂', {
      supplementFrequency: 'weekdays',
      supplementWeekdays: ['monday'],
      supplementDosage: 1,
    });
    const missingDosage: FoodInput = { ...validDailyInput };
    const missingWeekdays: FoodInput = { ...validWeekdayInput };
    delete missingDosage.supplementDosage;
    delete missingWeekdays.supplementWeekdays;

    expect(foodInputSchema.safeParse(validDailyInput).success).toBe(true);
    expect(foodInputSchema.safeParse(validWeekdayInput).success).toBe(true);
    expect(foodInputSchema.safeParse(createSupplementInput('合法按需补剂')).success).toBe(true);
    expect(foodInputSchema.safeParse(missingDosage).success).toBe(false);
    expect(foodInputSchema.safeParse(missingWeekdays).success).toBe(false);
    expect(
      foodInputSchema.safeParse(
        createSupplementInput('缺少每份重量的补剂', {
          defaultServingGrams: null,
          supplementFrequency: 'daily',
          supplementDosage: 1,
          supplementDosageUnit: 'serving',
        }),
      ).success,
    ).toBe(false);
    expect(
      foodInputSchema.safeParse({
        name: '错误携带补剂用量的普通食物',
        category: '其他',
        caloriesPer100g: 100,
        proteinPer100g: 10,
        carbsPer100g: 10,
        fatPer100g: 1,
        supplementDosage: 2,
      }).success,
    ).toBe(false);
  });

  it('更新按份补剂时省略默认每份重量仍保留原值和有效计划', () => {
    const originalInput = createSupplementInput('按份更新测试补剂', {
      defaultServingGrams: 12,
      supplementFrequency: 'daily',
      supplementDosage: 1,
      supplementDosageUnit: 'serving',
    });
    const supplement = service.createFood(originalInput);
    const updateInput: FoodInput = {
      ...originalInput,
      name: '按份更新测试补剂（已编辑）',
    };
    delete updateInput.defaultServingGrams;

    expect(service.updateFood(supplement.id, updateInput)).toMatchObject({
      name: '按份更新测试补剂（已编辑）',
      defaultServingGrams: 12,
      supplementFrequency: 'daily',
      supplementDosage: 1,
      supplementDosageUnit: 'serving',
    });
  });

  it('常用组合拒绝补剂，避免补剂被写入普通餐次', () => {
    const supplement = service.createFood(createSupplementInput('组合边界测试补剂'));

    expect(() =>
      service.createFoodCombination({
        name: '错误补剂组合',
        items: [{ foodId: supplement.id, amount: 10, unitType: 'gram' }],
      }),
    ).toThrow('常用组合只能包含普通食物');
  });

  it('从 v6 升级到 v7 时保留原有四餐记录并补齐补剂计划默认值', () => {
    const legacyFood = service.createFood({
      name: '升级保留鸡胸肉',
      category: '肉类',
      caloriesPer100g: 165,
      proteinPer100g: 31,
      carbsPer100g: 0,
      fatPer100g: 3.6,
    });
    const legacySupplement = service.createFood(
      createSupplementInput('升级保留补剂', {
        supplementFrequency: 'daily',
        supplementDosage: 3,
      }),
    );
    const breakfastRecord = service.createMealRecord({
      recordDate: '2026-08-23',
      mealType: 'breakfast',
      foodId: legacyFood.id,
      amount: 100,
      unitType: 'gram',
    });
    const snackRecord = service.createMealRecord({
      recordDate: '2026-08-23',
      mealType: 'snack',
      foodId: legacySupplement.id,
      amount: 10,
      unitType: 'gram',
    });
    const deletedHighRecord = service.createMealRecord({
      recordDate: '2026-08-24',
      mealType: 'breakfast',
      foodId: legacyFood.id,
      amount: 50,
      unitType: 'gram',
    });
    service.deleteMealRecord(deletedHighRecord.id);
    service.close();

    const versionSevenDatabase = new DatabaseSync(databasePath);
    const mealTable = versionSevenDatabase
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'meal_records'")
      .get() as { sql: string };
    const versionSixMealSql = mealTable.sql
      .replace(/CREATE TABLE\s+"?meal_records"?/i, 'CREATE TABLE meal_records_v6')
      .replace(/,\s*'supplement'/, '');

    // 还原 v6 的四餐约束和 foods 列，让升级路径真实执行新增列与表重建。
    versionSevenDatabase.exec(`
      PRAGMA foreign_keys = OFF;
      DROP INDEX idx_foods_supplement_schedule;
      ${versionSixMealSql};
      INSERT INTO meal_records_v6 SELECT * FROM meal_records;
      ALTER TABLE meal_records_v6 DROP COLUMN recommendation_metric;
      ALTER TABLE meal_records_v6 DROP COLUMN amount_mode;
      DROP TABLE meal_records;
      ALTER TABLE meal_records_v6 RENAME TO meal_records;
      UPDATE sqlite_sequence SET seq = ${deletedHighRecord.id} WHERE name = 'meal_records';
      CREATE INDEX idx_meal_records_date ON meal_records(record_date);
      CREATE INDEX idx_meal_records_date_type_order
        ON meal_records(record_date, meal_type, sort_order, id);
      CREATE INDEX idx_meal_records_food_id ON meal_records(food_id);
      ALTER TABLE foods DROP COLUMN supplement_dosage_unit;
      ALTER TABLE foods DROP COLUMN supplement_dosage;
      ALTER TABLE foods DROP COLUMN supplement_weekdays;
      ALTER TABLE foods DROP COLUMN supplement_frequency;
      DROP TABLE daily_meal_settings;
      ALTER TABLE daily_plan_snapshots DROP COLUMN dinner_ratio;
      ALTER TABLE daily_plan_snapshots DROP COLUMN lunch_ratio;
      ALTER TABLE daily_plan_snapshots DROP COLUMN breakfast_ratio;
      ALTER TABLE diet_plans DROP COLUMN dinner_ratio;
      ALTER TABLE diet_plans DROP COLUMN lunch_ratio;
      ALTER TABLE diet_plans DROP COLUMN breakfast_ratio;
      ALTER TABLE diet_plan_variants DROP COLUMN fat_per_kg;
      ALTER TABLE diet_plan_variants DROP COLUMN carbs_per_kg;
      ALTER TABLE diet_plan_variants DROP COLUMN protein_per_kg;
      ALTER TABLE diet_plan_variants DROP COLUMN weight_source_date;
      ALTER TABLE diet_plan_variants DROP COLUMN calculation_weight;
      ALTER TABLE diet_plan_variants DROP COLUMN calculation_mode;
      DELETE FROM schema_migrations WHERE version >= 7;
      PRAGMA user_version = 6;
      PRAGMA foreign_keys = ON;
    `);
    versionSevenDatabase.close();

    service = new DatabaseService(databasePath, '0.6.0-test');
    service.initialize();

    expect(service.getAppInfo().databaseVersion).toBe(10);
    expect(service.getDashboard('2026-08-23').meals.breakfast).toEqual([
      expect.objectContaining({
        id: breakfastRecord.id,
        foodNameSnapshot: '升级保留鸡胸肉',
        calories: 165,
      }),
    ]);
    expect(service.getDashboard('2026-08-23').meals.snack).toEqual([
      expect.objectContaining({
        id: snackRecord.id,
        foodNameSnapshot: '升级保留补剂',
        calories: 10,
      }),
    ]);
    expect(
      service.listFoods({ includeArchived: true }).find((food) => food.id === legacyFood.id),
    ).toMatchObject({
      supplementFrequency: 'as_needed',
      supplementWeekdays: [],
      supplementDosage: null,
      supplementDosageUnit: 'gram',
    });
    const postUpgradeRecord = service.createMealRecord({
      recordDate: '2026-08-25',
      mealType: 'breakfast',
      foodId: legacyFood.id,
      amount: 75,
      unitType: 'gram',
    });
    expect(postUpgradeRecord.id).toBeGreaterThan(deletedHighRecord.id);
  });
});
