import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../electron/database';
import { foodQuerySchema } from '../electron/ipc/schemas';
import type { DietPlanInput, FoodInput } from '../src/types/models';
import { shiftDate, toLocalDateString } from '../src/utils/date';

describe('本地数据库', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let service: DatabaseService;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'diet-tracker-test-'));
    databasePath = join(temporaryDirectory, 'diet-tracker.db');
    service = new DatabaseService(databasePath, '0.1.0-test');
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

  it('首次启动执行全部 migration，重复初始化不会重复写入种子数据', () => {
    const initialFoodCount = service.listFoods({ includeArchived: true, limit: 500 }).length;
    const initialPlanCount = service.listDietPlans().length;

    expect(service.getAppInfo()).toEqual({
      version: '0.1.0-test',
      databasePath,
      databaseVersion: 10,
    });
    expect(initialFoodCount).toBeGreaterThan(0);
    expect(initialPlanCount).toBeGreaterThan(0);

    service.close();
    const inspectionDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const migrationVersions = inspectionDatabase
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => Number((row as { version: number }).version));
    const userVersionRow = inspectionDatabase.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    const indexNames = inspectionDatabase
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => String((row as { name: string }).name));
    inspectionDatabase.close();

    expect(migrationVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(userVersionRow.user_version).toBe(10);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'idx_body_records_record_date',
        'idx_foods_name',
        'idx_foods_pinyin_initials',
        'idx_foods_supplement_archived',
        'idx_foods_supplement_schedule',
        'idx_meal_records_date_type_order',
        'idx_diet_plans_active',
        'idx_daily_plan_snapshots_plan_date',
        'idx_diet_plan_variants_plan_name',
        'idx_diet_plan_variants_plan_updated',
        'idx_daily_plan_snapshots_variant_date',
      ]),
    );

    service = new DatabaseService(databasePath, '0.1.0-test');
    service.initialize();

    expect(service.listFoods({ includeArchived: true, limit: 500 })).toHaveLength(initialFoodCount);
    expect(service.listDietPlans()).toHaveLength(initialPlanCount);
  });

  it('已有活动方案的旧数据库升级时不会重复插入默认方案', () => {
    const initialFoodCount = service.listFoods({ includeArchived: true }).length;
    const initialPlanCount = service.listDietPlans().length;
    service.close();

    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
      DROP INDEX idx_foods_pinyin_initials;
      DROP TABLE daily_meal_settings;
      DROP INDEX idx_meal_records_indulgence;
      ALTER TABLE meal_records DROP COLUMN recommendation_metric;
      ALTER TABLE meal_records DROP COLUMN amount_mode;
      DROP TABLE daily_plan_snapshots;
      DROP TABLE diet_plan_variants;
      ALTER TABLE foods DROP COLUMN pinyin_initials;
      ALTER TABLE diet_plans DROP COLUMN fat_per_kg;
      ALTER TABLE diet_plans DROP COLUMN carbs_per_kg;
      ALTER TABLE diet_plans DROP COLUMN protein_per_kg;
      ALTER TABLE diet_plans DROP COLUMN weight_source_date;
      ALTER TABLE diet_plans DROP COLUMN calculation_weight;
      ALTER TABLE diet_plans DROP COLUMN calculation_mode;
      ALTER TABLE diet_plans DROP COLUMN dinner_ratio;
      ALTER TABLE diet_plans DROP COLUMN lunch_ratio;
      ALTER TABLE diet_plans DROP COLUMN breakfast_ratio;
      DROP INDEX idx_foods_supplement_schedule;
      ALTER TABLE foods DROP COLUMN supplement_dosage_unit;
      ALTER TABLE foods DROP COLUMN supplement_dosage;
      ALTER TABLE foods DROP COLUMN supplement_weekdays;
      ALTER TABLE foods DROP COLUMN supplement_frequency;
      DELETE FROM schema_migrations WHERE version >= 2;
      PRAGMA user_version = 1;
    `);
    legacyDatabase.close();

    service = new DatabaseService(databasePath, '0.1.0-test');
    expect(() => service.initialize()).not.toThrow();
    expect(service.getAppInfo().databaseVersion).toBe(10);
    expect(service.listDietPlans()).toHaveLength(initialPlanCount);
    expect(service.listDietPlans().filter((plan) => plan.isActive)).toHaveLength(1);
    expect(service.listFoods({ includeArchived: true })).toHaveLength(initialFoodCount);
  });

  it('首次启动创建七种零营养默认补剂并与食物库分离', () => {
    const expectedNames = [
      '肌酸',
      '电解质冲粉',
      '蛋白粉',
      '锌镁片',
      '复合维生素',
      '鱼油',
      '谷氨酰胺',
    ];
    const supplements = service
      .listFoods({ kind: 'supplement', includeArchived: true })
      .filter((food) => expectedNames.includes(food.name));

    expect(supplements.map((food) => food.name).sort()).toEqual([...expectedNames].sort());
    for (const supplement of supplements) {
      expect(supplement).toMatchObject({
        category: '补剂',
        caloriesPer100g: 0,
        proteinPer100g: 0,
        carbsPer100g: 0,
        fatPer100g: 0,
        defaultServingGrams: null,
        isSupplement: true,
        isRecommendable: false,
      });
      expect(supplement.note).not.toBe('');
      expect(supplement.note).toMatch(/标签|证据/);
    }
    expect(
      supplements
        .filter((food) => food.countInNutrition)
        .map((food) => food.name)
        .sort(),
    ).toEqual(['蛋白粉', '鱼油'].sort());

    const foodIds = new Set(service.listFoods({ kind: 'food' }).map((food) => food.id));
    expect(supplements.every((supplement) => !foodIds.has(supplement.id))).toBe(true);
    expect(service.listFoods({ kind: 'all' })).toEqual(
      expect.arrayContaining(
        supplements.map((supplement) => expect.objectContaining({ id: supplement.id })),
      ),
    );
    expect(foodQuerySchema.parse({ kind: 'supplement' })).toEqual({ kind: 'supplement' });
    expect(() => foodQuerySchema.parse({ kind: 'medicine' })).toThrow(/食物类型/);
  });

  it('补剂库同时识别补剂标记和旧补剂分类', () => {
    const flagOnly = service.createFood({
      name: '仅补剂标记',
      category: '其他',
      caloriesPer100g: 0,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 0,
      isSupplement: true,
    });
    const categoryOnly = service.createFood({
      name: '仅补剂分类',
      category: '补剂',
      caloriesPer100g: 0,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 0,
      isSupplement: false,
    });

    const supplementIds = service.listFoods({ kind: 'supplement' }).map((food) => food.id);
    const foodIds = service.listFoods({ kind: 'food' }).map((food) => food.id);
    expect(supplementIds).toEqual(expect.arrayContaining([flagOnly.id, categoryOnly.id]));
    expect(foodIds).not.toContain(flagOnly.id);
    expect(foodIds).not.toContain(categoryOnly.id);
  });

  it('蔬菜热量在今日、历史汇总和历史明细中使用同一快照值', () => {
    const vegetable = service.createFood({
      name: '热量一致性蔬菜',
      category: '蔬菜',
      caloriesPer100g: 35,
      proteinPer100g: 2,
      carbsPer100g: 6,
      fatPer100g: 0.5,
    });
    service.createMealRecord({
      recordDate: '2026-08-22',
      mealType: 'lunch',
      foodId: vegetable.id,
      amount: 200,
      unitType: 'gram',
    });

    expect(service.getDashboard('2026-08-22').nutrition.consumed.calories).toBe(70);
    expect(
      service.listHistory({ startDate: '2026-08-22', endDate: '2026-08-22' })[0],
    ).toMatchObject({ nutrition: { calories: 70 } });
    expect(service.getHistoryDay('2026-08-22').meals.lunch[0].calories).toBe(70);
  });

  it('v4 升级仅清理旧内置指纹，保留用户定制、停用状态和历史快照', () => {
    const legacyNote = '内置参考值，可按食品标签修改。';
    const supplements = service.listFoods({ kind: 'supplement', includeArchived: true });
    const fishOil = supplements.find((food) => food.name === '鱼油');
    const multivitamin = supplements.find((food) => food.name === '复合维生素');
    const proteinPowder = supplements.find((food) => food.name === '蛋白粉');
    if (!fishOil || !multivitamin || !proteinPowder) {
      throw new Error('测试数据库缺少默认补剂');
    }

    service.updateFood(fishOil.id, {
      name: '鱼油',
      category: '补剂',
      caloriesPer100g: 1000,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 100,
      defaultServingGrams: 1,
      unitName: '粒',
      isSupplement: true,
      countInNutrition: false,
      isRecommendable: false,
      note: legacyNote,
    });
    service.setFoodFavorite(fishOil.id, true);
    const historicalMeal = service.createMealRecord({
      recordDate: '2026-08-09',
      mealType: 'snack',
      foodId: fishOil.id,
      amount: 2,
      unitType: 'serving',
    });
    expect(historicalMeal).toMatchObject({
      calories: 20,
      fat: 2,
      countInNutritionSnapshot: false,
    });

    service.updateFood(multivitamin.id, {
      name: '复合维生素',
      category: '补剂',
      caloriesPer100g: 0,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 0,
      defaultServingGrams: 1,
      unitName: '片',
      isSupplement: true,
      countInNutrition: false,
      isRecommendable: false,
      note: legacyNote,
    });
    service.archiveFood(multivitamin.id);

    service.updateFood(proteinPowder.id, {
      name: '蛋白粉',
      brand: '用户品牌',
      category: '奶制品',
      caloriesPer100g: 390,
      proteinPer100g: 78,
      carbsPer100g: 8,
      fatPer100g: 6,
      defaultServingGrams: 30,
      unitName: '勺',
      isSupplement: false,
      countInNutrition: false,
      isRecommendable: true,
      note: '用户自定义说明',
    });

    service.close();
    const versionFourDatabase = new DatabaseSync(databasePath);
    versionFourDatabase.exec(`
      DELETE FROM foods WHERE name = '电解质冲粉';
      DROP INDEX idx_daily_plan_snapshots_variant_date;
      ALTER TABLE daily_plan_snapshots DROP COLUMN variant_name;
      ALTER TABLE daily_plan_snapshots DROP COLUMN variant_id;
      DROP TABLE diet_plan_variants;
      DELETE FROM schema_migrations WHERE version IN (5, 6);
      PRAGMA user_version = 4;
    `);
    versionFourDatabase.close();

    service = new DatabaseService(databasePath, '0.1.0-test');
    service.initialize();

    const migratedFishOil = service
      .listFoods({ kind: 'supplement', includeArchived: true })
      .find((food) => food.id === fishOil.id);
    expect(migratedFishOil).toMatchObject({
      caloriesPer100g: 0,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 0,
      defaultServingGrams: null,
      countInNutrition: false,
      isFavorite: true,
      usageCount: 1,
    });
    expect(migratedFishOil?.lastUsedAt).not.toBeNull();
    expect(migratedFishOil?.note).toContain('Omega-3');
    expect(service.getDashboard('2026-08-09').meals.snack[0]).toMatchObject({
      calories: 20,
      fat: 2,
      defaultServingGramsSnapshot: 1,
    });

    expect(
      service
        .listFoods({ kind: 'supplement', includeArchived: true })
        .find((food) => food.id === multivitamin.id),
    ).toMatchObject({ isArchived: true, defaultServingGrams: null });

    const migratedProteinPowder = service
      .listFoods({ kind: 'supplement', includeArchived: true })
      .find((food) => food.id === proteinPowder.id);
    expect(migratedProteinPowder).toMatchObject({
      brand: '用户品牌',
      category: '补剂',
      caloriesPer100g: 390,
      proteinPer100g: 78,
      carbsPer100g: 8,
      fatPer100g: 6,
      defaultServingGrams: 30,
      unitName: '勺',
      isSupplement: true,
      countInNutrition: false,
      isRecommendable: false,
      note: '用户自定义说明',
    });
    expect(service.listFoods({ kind: 'food' }).map((food) => food.id)).not.toContain(
      proteinPowder.id,
    );
    expect(service.listFoods({ kind: 'supplement', search: '电解质冲粉' })).toEqual([
      expect.objectContaining({
        name: '电解质冲粉',
        caloriesPer100g: 0,
        defaultServingGrams: null,
      }),
    ]);
  });

  it('同一天重复保存身体数据时更新原记录并保留未提交字段', () => {
    const first = service.upsertBodyRecord({
      recordDate: '2026-08-10',
      weight: 70.2,
      bodyFatPercentage: 18.5,
      waistCircumference: 78.4,
      note: '晨起空腹',
    });
    const updated = service.upsertBodyRecord({
      recordDate: '2026-08-10',
      weight: 69.9,
    });

    expect(updated).toMatchObject({
      id: first.id,
      recordDate: '2026-08-10',
      weight: 69.9,
      bodyFatPercentage: 18.5,
      waistCircumference: 78.4,
      note: '晨起空腹',
    });
    expect(service.listBodyRecords()).toHaveLength(1);
  });

  it('切换饮食方案后仅保留一个当前方案并立即更新目标', () => {
    const planInput: DietPlanInput = {
      name: '测试减脂方案',
      goalType: '减脂',
      targetCalories: 1800,
      targetProtein: 150,
      targetCarbs: 175,
      targetFat: 55,
      startDate: '2026-08-10',
      note: '数据库自动化测试',
    };
    const plan = service.createDietPlan(planInput);

    expect(plan.isActive).toBe(false);
    const activated = service.activateDietPlan(plan.id);
    const allPlans = service.listDietPlans();
    const dashboard = service.getDashboard('2026-08-10');

    expect(activated.isActive).toBe(true);
    expect(allPlans.filter((item) => item.isActive)).toHaveLength(1);
    expect(allPlans.find((item) => item.id === plan.id)?.isActive).toBe(true);
    expect(dashboard.activePlan?.id).toBe(plan.id);
    expect(dashboard.nutrition.target).toEqual({
      calories: 1800,
      protein: 150,
      carbs: 175,
      fat: 55,
    });
  });

  it('按体重系数方案完整保存计算来源，手动方案保持兼容', () => {
    const weighted = service.createDietPlan({
      name: '体重系数方案',
      goalType: '增肌',
      targetCalories: 2030,
      targetProtein: 140,
      targetCarbs: 210,
      targetFat: 70,
      calculationMode: 'weight_based',
      weightSourceMode: 'manual',
      calculationWeight: 70,
      weightSourceDate: null,
      proteinPerKg: 2,
      carbsPerKg: 3,
      fatPerKg: 1,
      startDate: '2026-08-10',
    });

    expect(weighted).toMatchObject({
      calculationMode: 'weight_based',
      weightSourceMode: 'manual',
      calculationWeight: 70,
      weightSourceDate: null,
      proteinPerKg: 2,
      carbsPerKg: 3,
      fatPerKg: 1,
    });

    const updated = service.updateDietPlan(weighted.id, {
      name: '手动方案',
      goalType: '自定义',
      targetCalories: 2000,
      targetProtein: 120,
      targetCarbs: 230,
      targetFat: 67,
      startDate: '2026-08-10',
    });
    expect(updated).toMatchObject({
      calculationMode: 'manual',
      calculationWeight: null,
      weightSourceDate: null,
      proteinPerKg: null,
      carbsPerKg: null,
      fatPerKg: null,
    });

    expect(() =>
      service.createDietPlan({
        name: '无效系数方案',
        goalType: '自定义',
        targetCalories: 2000,
        targetProtein: 120,
        targetCarbs: 230,
        targetFat: 67,
        calculationMode: 'weight_based',
        weightSourceMode: 'manual',
        calculationWeight: 70,
        weightSourceDate: null,
        proteinPerKg: 2,
        carbsPerKg: 21,
        fatPerKg: 1,
        startDate: '2026-08-10',
      }),
    ).toThrow(/碳水系数/);
    expect(() =>
      service.createDietPlan({
        name: '超重边界方案',
        goalType: '自定义',
        targetCalories: 2000,
        targetProtein: 120,
        targetCarbs: 230,
        targetFat: 67,
        calculationMode: 'weight_based',
        weightSourceMode: 'manual',
        calculationWeight: 1001,
        weightSourceDate: null,
        proteinPerKg: 2,
        carbsPerKg: 3,
        fatPerKg: 1,
        startDate: '2026-08-10',
      }),
    ).toThrow(/1000 kg/);

    service.close();
    const constraintDatabase = new DatabaseSync(databasePath);
    expect(() =>
      constraintDatabase
        .prepare('UPDATE diet_plans SET calculation_weight = -1 WHERE id = ?')
        .run(weighted.id),
    ).toThrow(/CHECK constraint failed/);
    constraintDatabase.close();
    service = new DatabaseService(databasePath, '0.1.0-test');
    service.initialize();
  });

  it('最新体重会刷新自动方案和今天快照，手动体重保持固定', () => {
    const today = toLocalDateString(new Date());
    const previousDate = shiftDate(today, -1);
    service.upsertBodyRecord({ recordDate: previousDate, weight: 70 });
    const automaticPlan = service.createDietPlan({
      name: '自动体重方案',
      goalType: '增肌',
      targetCalories: 2030,
      targetProtein: 140,
      targetCarbs: 210,
      targetFat: 70,
      calculationMode: 'weight_based',
      weightSourceMode: 'latest',
      calculationWeight: 70,
      weightSourceDate: previousDate,
      proteinPerKg: 2,
      carbsPerKg: 3,
      fatPerKg: 1,
      startDate: previousDate,
    });
    const manualPlan = service.createDietPlan({
      name: '手动体重方案',
      goalType: '增肌',
      targetCalories: 2030,
      targetProtein: 140,
      targetCarbs: 210,
      targetFat: 70,
      calculationMode: 'weight_based',
      weightSourceMode: 'manual',
      calculationWeight: 70,
      weightSourceDate: null,
      proteinPerKg: 2,
      carbsPerKg: 3,
      fatPerKg: 1,
      startDate: previousDate,
    });
    service.activateDietPlan(automaticPlan.id);

    const latestRecord = service.upsertBodyRecord({ recordDate: today, weight: 72 });
    expect(service.listDietPlans().find((plan) => plan.id === automaticPlan.id)).toMatchObject({
      calculationWeight: 72,
      weightSourceDate: today,
      calories: 2088,
      protein: 144,
      carbs: 216,
      fat: 72,
    });
    expect(service.getDashboard(today).nutrition.target).toEqual({
      calories: 2088,
      protein: 144,
      carbs: 216,
      fat: 72,
    });
    expect(service.listDietPlans().find((plan) => plan.id === manualPlan.id)).toMatchObject({
      weightSourceMode: 'manual',
      calculationWeight: 70,
      weightSourceDate: null,
      calories: 2030,
      protein: 140,
      carbs: 210,
      fat: 70,
    });

    service.deleteBodyRecord(latestRecord.id);
    expect(service.listDietPlans().find((plan) => plan.id === automaticPlan.id)).toMatchObject({
      calculationWeight: 70,
      weightSourceDate: previousDate,
      calories: 2030,
      protein: 140,
      carbs: 210,
      fat: 70,
    });
  });

  it('v3 数据库升级到 v4 时保留目标并标记为手动方案', () => {
    const planBeforeUpgrade = service.listDietPlans()[0];
    service.close();
    const versionThreeDatabase = new DatabaseSync(databasePath);
    versionThreeDatabase.exec(`
      ALTER TABLE diet_plans DROP COLUMN fat_per_kg;
      ALTER TABLE diet_plans DROP COLUMN carbs_per_kg;
      ALTER TABLE diet_plans DROP COLUMN protein_per_kg;
      ALTER TABLE diet_plans DROP COLUMN weight_source_date;
      ALTER TABLE diet_plans DROP COLUMN calculation_weight;
      ALTER TABLE diet_plans DROP COLUMN calculation_mode;
      DROP INDEX idx_daily_plan_snapshots_variant_date;
      ALTER TABLE daily_plan_snapshots DROP COLUMN variant_name;
      ALTER TABLE daily_plan_snapshots DROP COLUMN variant_id;
      DROP TABLE diet_plan_variants;
      DELETE FROM schema_migrations WHERE version IN (4, 5, 6);
      PRAGMA user_version = 3;
    `);
    versionThreeDatabase.close();

    service = new DatabaseService(databasePath, '0.1.0-test');
    service.initialize();
    expect(service.getAppInfo().databaseVersion).toBe(10);
    expect(service.listDietPlans()[0]).toMatchObject({
      id: planBeforeUpgrade.id,
      calories: planBeforeUpgrade.calories,
      protein: planBeforeUpgrade.protein,
      carbs: planBeforeUpgrade.carbs,
      fat: planBeforeUpgrade.fat,
      calculationMode: 'manual',
      calculationWeight: null,
      weightSourceDate: null,
      proteinPerKg: null,
      carbsPerKg: null,
      fatPerKg: null,
    });
  });

  it('食物库修改后保留历史营养和计入开关快照', () => {
    const originalFoodInput: FoodInput = {
      name: '测试鸡胸肉',
      brand: '测试品牌',
      category: '肉类',
      caloriesPer100g: 165,
      proteinPer100g: 31,
      carbsPer100g: 0,
      fatPer100g: 3.6,
      defaultServingGrams: 100,
      unitName: '份',
      countInNutrition: true,
    };
    const food = service.createFood(originalFoodInput);
    const historicalMeal = service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'breakfast',
      foodId: food.id,
      amount: 180,
      unitType: 'gram',
    });

    service.updateFood(food.id, {
      ...originalFoodInput,
      name: '测试鸡胸肉（新数据）',
      caloriesPer100g: 100,
      proteinPer100g: 20,
      fatPer100g: 2,
      countInNutrition: false,
    });
    const newMeal = service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'lunch',
      foodId: food.id,
      amount: 180,
      unitType: 'gram',
    });
    const dashboard = service.getDashboard('2026-08-10');

    expect(historicalMeal).toMatchObject({
      foodNameSnapshot: '测试鸡胸肉',
      gramsSnapshot: 180,
      calories: 297,
      protein: 55.8,
      fat: 6.48,
      countInNutritionSnapshot: true,
    });
    expect(newMeal).toMatchObject({
      foodNameSnapshot: '测试鸡胸肉（新数据）',
      calories: 180,
      protein: 36,
      fat: 3.6,
      countInNutritionSnapshot: false,
    });
    expect(dashboard.nutrition.consumed).toEqual({
      calories: 297,
      protein: 55.8,
      carbs: 0,
      fat: 6.48,
    });
  });

  it('鱼油和蛋白粉默认计入营养统计，其他补剂默认不计入', () => {
    const fishOil = service.createFood({
      name: '测试鱼油',
      category: '补剂',
      caloriesPer100g: 1000,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 100,
      defaultServingGrams: 1,
      unitName: '粒',
    });
    const vitamin = service.createFood({
      name: '测试复合维生素',
      category: '补剂',
      caloriesPer100g: 500,
      proteinPer100g: 50,
      carbsPer100g: 20,
      fatPer100g: 10,
      defaultServingGrams: 1,
      unitName: '片',
    });
    const proteinPowder = service.createFood({
      name: '测试蛋白粉',
      category: '补剂',
      caloriesPer100g: 400,
      proteinPer100g: 80,
      carbsPer100g: 10,
      fatPer100g: 5,
    });

    expect(fishOil.countInNutrition).toBe(true);
    expect(proteinPowder.countInNutrition).toBe(true);
    expect(vitamin.countInNutrition).toBe(false);

    service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'snack',
      foodId: fishOil.id,
      amount: 2,
      unitType: 'serving',
    });
    service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'snack',
      foodId: vitamin.id,
      amount: 1,
      unitType: 'serving',
    });

    expect(service.getDashboard('2026-08-10').nutrition.consumed).toEqual({
      calories: 20,
      protein: 0,
      carbs: 0,
      fat: 2,
    });
  });

  it('用户设置的补剂计入开关优先于默认名称规则', () => {
    const excludedFishOil = service.createFood({
      name: '不计入的鱼油',
      category: '补剂',
      caloriesPer100g: 1000,
      proteinPer100g: 0,
      carbsPer100g: 0,
      fatPer100g: 100,
      defaultServingGrams: 1,
      unitName: '粒',
      countInNutrition: false,
    });
    const includedProteinPowder = service.createFood({
      name: '计入的蛋白粉',
      category: '补剂',
      caloriesPer100g: 400,
      proteinPer100g: 80,
      carbsPer100g: 10,
      fatPer100g: 5,
      defaultServingGrams: 30,
      unitName: '勺',
      countInNutrition: true,
    });

    service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'snack',
      foodId: excludedFishOil.id,
      amount: 2,
      unitType: 'serving',
    });
    service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'snack',
      foodId: includedProteinPowder.id,
      amount: 1,
      unitType: 'serving',
    });

    expect(service.getDashboard('2026-08-10').nutrition.consumed).toEqual({
      calories: 120,
      protein: 24,
      carbs: 3,
      fat: 1.5,
    });
  });

  it('食物库搜索同时匹配名称和品牌', () => {
    const brandedFood = service.createFood({
      name: '原味酸奶',
      brand: '测试乳业',
      category: '奶制品',
      caloriesPer100g: 72,
      proteinPer100g: 3.5,
      carbsPer100g: 8.4,
      fatPer100g: 2.6,
    });

    expect(service.listFoods({ search: '测试乳业' }).map((food) => food.id)).toContain(
      brandedFood.id,
    );
  });

  it('克和份之间切换时保留原始份量单位快照', () => {
    const egg = service.createFood({
      name: '单位切换测试鸡蛋',
      category: '蛋类',
      caloriesPer100g: 144,
      proteinPer100g: 13.3,
      carbsPer100g: 2.8,
      fatPer100g: 8.8,
      defaultServingGrams: 50,
      unitName: '个',
    });
    const meal = service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'breakfast',
      foodId: egg.id,
      amount: 100,
      unitType: 'gram',
    });

    const updated = service.updateMealRecord({
      id: meal.id,
      amount: 2,
      unitType: 'serving',
    });

    expect(updated).toMatchObject({
      amount: 2,
      unitType: 'serving',
      unitNameSnapshot: '个',
      gramsSnapshot: 100,
    });
  });

  it('按个记录接受小数并正确保存营养快照，按克记录保存一位小数', () => {
    const egg = service.createFood({
      name: '数量规则测试鸡蛋',
      category: '蛋类',
      caloriesPer100g: 144,
      proteinPer100g: 13.3,
      carbsPer100g: 2.8,
      fatPer100g: 8.8,
      defaultServingGrams: 50,
      unitName: '个',
    });

    const eggRecord = service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'breakfast',
      foodId: egg.id,
      amount: 3,
      unitType: 'serving',
    });
    expect(eggRecord).toMatchObject({ amount: 3, gramsSnapshot: 150 });

    const fractionalRecord = service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'lunch',
      foodId: egg.id,
      amount: 3.5,
      unitType: 'serving',
    });
    expect(fractionalRecord).toMatchObject({ amount: 3.5, gramsSnapshot: 175, calories: 252 });

    const halfEgg = service.updateMealRecord({
      id: fractionalRecord.id,
      amount: 0.5,
      unitType: 'serving',
    });
    expect(halfEgg).toMatchObject({ amount: 0.5, gramsSnapshot: 25, calories: 36 });

    const combination = service.createFoodCombination({
      name: '半个鸡蛋组合',
      items: [{ foodId: egg.id, amount: 0.5, unitType: 'serving' }],
    });
    expect(combination.items[0]).toMatchObject({ amount: 0.5, unitType: 'serving' });

    const weightRecord = service.createMealRecord({
      recordDate: '2026-08-10',
      mealType: 'dinner',
      foodId: egg.id,
      amount: 33.26,
      unitType: 'gram',
    });
    expect(weightRecord).toMatchObject({ amount: 33.3, gramsSnapshot: 33.3 });
  });
});
