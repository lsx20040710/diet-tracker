import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../electron/database';
import type { FoodInput, MealType } from '../src/types/models';
import { shiftDate, toLocalDateString } from '../src/utils/date';

const TEST_DATE = '2026-07-01';

function createFoodInput(name: string, overrides: Partial<FoodInput> = {}): FoodInput {
  return {
    name,
    category: '其他',
    caloriesPer100g: 100,
    proteinPer100g: 10,
    carbsPer100g: 5,
    fatPer100g: 2,
    defaultServingGrams: 50,
    unitName: '份',
    ...overrides,
  };
}

describe('第二阶段本地数据库', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let service: DatabaseService;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'diet-tracker-phase2-test-'));
    databasePath = join(temporaryDirectory, 'diet-tracker.db');
    service = new DatabaseService(databasePath, '0.2.0-test');
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

  it('从 v2 升级到当前版本时保留数据，重复启动不重复执行 migration', () => {
    const food = service.createFood(createFoodInput('升级保留食物'));
    service.upsertBodyRecord({ recordDate: TEST_DATE, weight: 70.2 });
    service.createMealRecord({
      recordDate: TEST_DATE,
      mealType: 'breakfast',
      foodId: food.id,
      amount: 80,
      unitType: 'gram',
    });
    const foodCount = service.listFoods({ includeArchived: true }).length;
    const planCount = service.listDietPlans().length;
    service.close();

    // 还原出真实的 v2 表结构，用于验证新增列和快照表的升级路径。
    const versionTwoDatabase = new DatabaseSync(databasePath);
    const pinyinIndexes = versionTwoDatabase
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'foods' AND sql LIKE '%pinyin_initials%'`,
      )
      .all() as Array<{ name: string }>;
    for (const index of pinyinIndexes) {
      versionTwoDatabase.exec(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
    }
    versionTwoDatabase.exec(`
      DROP TABLE IF EXISTS daily_plan_snapshots;
      DROP TABLE IF EXISTS diet_plan_variants;
      ALTER TABLE foods DROP COLUMN pinyin_initials;
      ALTER TABLE diet_plans DROP COLUMN fat_per_kg;
      ALTER TABLE diet_plans DROP COLUMN carbs_per_kg;
      ALTER TABLE diet_plans DROP COLUMN protein_per_kg;
      ALTER TABLE diet_plans DROP COLUMN weight_source_date;
      ALTER TABLE diet_plans DROP COLUMN calculation_weight;
      ALTER TABLE diet_plans DROP COLUMN calculation_mode;
      DELETE FROM schema_migrations WHERE version IN (3, 4, 5, 6);
      PRAGMA user_version = 2;
    `);
    versionTwoDatabase.close();

    service = new DatabaseService(databasePath, '0.2.0-test');
    service.initialize();

    expect(service.getAppInfo().databaseVersion).toBe(10);
    expect(service.listFoods({ includeArchived: true })).toHaveLength(foodCount);
    expect(service.listFoods({ search: 'sjblsw' }).map((item) => item.id)).toContain(food.id);
    expect(service.listDietPlans()).toHaveLength(planCount);
    expect(service.listBodyRecords()).toEqual([
      expect.objectContaining({ recordDate: TEST_DATE, weight: 70.2 }),
    ]);
    expect(service.getDashboard(TEST_DATE).meals.breakfast).toEqual([
      expect.objectContaining({ foodNameSnapshot: '升级保留食物', gramsSnapshot: 80 }),
    ]);

    service.close();
    service = new DatabaseService(databasePath, '0.2.0-test');
    service.initialize();
    service.close();

    const inspectionDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const migrationCount = inspectionDatabase
      .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version IN (3, 4, 5, 6)')
      .get() as { count: number };
    const preservedFoodCount = inspectionDatabase
      .prepare('SELECT COUNT(*) AS count FROM foods')
      .get() as { count: number };
    inspectionDatabase.close();

    expect(Number(migrationCount.count)).toBe(4);
    expect(Number(preservedFoodCount.count)).toBe(foodCount);

    service = new DatabaseService(databasePath, '0.2.0-test');
    service.initialize();
  });

  it('食物搜索依次按名称匹配和拼音首字母匹配程度排序', () => {
    const exactName = service.createFood(createFoodInput('蛋白粉'));
    const namePrefix = service.createFood(createFoodInput('蛋白粉香草味'));
    const nameContains = service.createFood(createFoodInput('香草味蛋白粉'));
    service.setFoodFavorite(nameContains.id, true);

    const nameOrder = service
      .listFoods({ search: '蛋白粉' })
      .filter((food) => [exactName.id, namePrefix.id, nameContains.id].includes(food.id))
      .map((food) => food.id);
    expect(nameOrder).toEqual([exactName.id, namePrefix.id, nameContains.id]);

    const exactPinyin = service.createFood(createFoodInput('鸡胸肉'));
    const pinyinPrefix = service.createFood(createFoodInput('鸡胸肉沙拉'));
    const pinyinContains = service.createFood(createFoodInput('香煎鸡胸肉'));
    service.createMealRecord({
      recordDate: TEST_DATE,
      mealType: 'breakfast',
      foodId: pinyinContains.id,
      amount: 100,
      unitType: 'gram',
    });

    const pinyinOrder = service
      .listFoods({ search: 'jxr' })
      .filter((food) => [exactPinyin.id, pinyinPrefix.id, pinyinContains.id].includes(food.id))
      .map((food) => food.id);
    expect(pinyinOrder).toEqual([exactPinyin.id, pinyinPrefix.id, pinyinContains.id]);

    const punctuationName = service.createFood(createFoodInput('鸡胸肉（熟）'));
    expect(service.listFoods({ search: 'jxrs' }).map((food) => food.id)).toContain(
      punctuationName.id,
    );
  });

  it('最近使用和常用范围只返回对应食物，收藏开关可反复切换', () => {
    const favorite = service.createFood(createFoodInput('收藏范围食物'));
    const recent = service.createFood(createFoodInput('最近范围食物'));
    const unused = service.createFood(createFoodInput('未使用食物'));

    expect(service.setFoodFavorite(favorite.id, true).isFavorite).toBe(true);
    expect(service.listFoods({ scope: 'favorite' }).map((food) => food.id)).toContain(favorite.id);
    expect(service.listFoods({ scope: 'favorite' }).map((food) => food.id)).not.toContain(
      unused.id,
    );

    service.createMealRecord({
      recordDate: TEST_DATE,
      mealType: 'snack',
      foodId: recent.id,
      amount: 1,
      unitType: 'serving',
    });
    const recentIds = service.listFoods({ scope: 'recent', limit: 20 }).map((food) => food.id);
    expect(recentIds).toContain(recent.id);
    expect(recentIds).not.toContain(favorite.id);
    expect(recentIds).not.toContain(unused.id);

    expect(service.setFoodFavorite(favorite.id, false).isFavorite).toBe(false);
    expect(service.listFoods({ scope: 'favorite' }).map((food) => food.id)).not.toContain(
      favorite.id,
    );
  });

  it('常用组合支持创建、编辑、按份加入餐次和删除', () => {
    const chicken = service.createFood(
      createFoodInput('组合鸡胸肉', {
        category: '肉类',
        caloriesPer100g: 165,
        proteinPer100g: 31,
        carbsPer100g: 0,
        fatPer100g: 3.6,
        defaultServingGrams: 100,
      }),
    );
    const egg = service.createFood(
      createFoodInput('组合鸡蛋', {
        category: '蛋类',
        caloriesPer100g: 144,
        proteinPer100g: 13.3,
        carbsPer100g: 2.8,
        fatPer100g: 8.8,
        defaultServingGrams: 50,
        unitName: '个',
      }),
    );
    const combination = service.createFoodCombination({
      name: '测试早餐组合',
      description: '创建测试',
      items: [
        { foodId: chicken.id, amount: 120, unitType: 'gram' },
        { foodId: egg.id, amount: 2, unitType: 'serving' },
      ],
    });

    expect(combination.items.map((item) => item.food.id)).toEqual([chicken.id, egg.id]);
    expect(combination.items.map((item) => item.sortOrder)).toEqual([0, 1]);
    expect(service.listFoodCombinations().map((item) => item.id)).toContain(combination.id);

    const updated = service.updateFoodCombination(combination.id, {
      name: '训练日早餐组合',
      description: '编辑测试',
      items: [
        { foodId: egg.id, amount: 2, unitType: 'serving' },
        { foodId: chicken.id, amount: 100, unitType: 'gram' },
      ],
    });
    expect(updated).toMatchObject({ name: '训练日早餐组合', description: '编辑测试' });
    expect(updated.items.map((item) => item.food.id)).toEqual([egg.id, chicken.id]);

    const added = service.addCombinationToMeal({
      combinationId: combination.id,
      recordDate: TEST_DATE,
      mealType: 'breakfast',
    });
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({
      foodNameSnapshot: '组合鸡蛋',
      amount: 2,
      unitType: 'serving',
      unitNameSnapshot: '个',
      servingUnitNameSnapshot: '个',
      defaultServingGramsSnapshot: 50,
      gramsSnapshot: 100,
      calories: 144,
    });
    expect(service.getDashboard(TEST_DATE).meals.breakfast).toHaveLength(2);

    service.deleteFoodCombination(combination.id);
    expect(service.listFoodCombinations().map((item) => item.id)).not.toContain(combination.id);
  });

  it('组合中任一食物不可用时整次加入回滚', () => {
    const validFood = service.createFood(createFoodInput('事务有效食物'));
    const archivedFood = service.createFood(createFoodInput('事务停用食物'));
    const combination = service.createFoodCombination({
      name: '事务回滚组合',
      items: [
        { foodId: validFood.id, amount: 100, unitType: 'gram' },
        { foodId: archivedFood.id, amount: 1, unitType: 'serving' },
      ],
    });
    service.archiveFood(archivedFood.id);

    expect(() =>
      service.addCombinationToMeal({
        combinationId: combination.id,
        recordDate: TEST_DATE,
        mealType: 'lunch',
      }),
    ).toThrow();
    expect(service.getDashboard(TEST_DATE).meals.lunch).toEqual([]);
    expect(
      service.listFoods({ includeArchived: true }).find((food) => food.id === validFood.id)
        ?.usageCount,
    ).toBe(0);
  });

  it('复制饮食支持追加、仅覆盖所选餐次并保留其他餐次', () => {
    const food = service.createFood(createFoodInput('餐次复制食物'));
    const sourceDate = '2026-07-02';
    const targetDate = '2026-07-03';
    const createMeal = (recordDate: string, mealType: MealType, amount: number): void => {
      service.createMealRecord({
        recordDate,
        mealType,
        foodId: food.id,
        amount,
        unitType: 'gram',
      });
    };
    createMeal(sourceDate, 'breakfast', 100);
    createMeal(sourceDate, 'lunch', 120);
    createMeal(targetDate, 'breakfast', 40);
    createMeal(targetDate, 'lunch', 50);
    createMeal(targetDate, 'dinner', 60);

    const appended = service.copyMeals({
      sourceDate,
      targetDate,
      mealTypes: ['breakfast'],
      replaceExisting: false,
    });
    expect(appended.copiedCount).toBe(1);
    expect(
      service.getDashboard(targetDate).meals.breakfast.map((meal) => meal.gramsSnapshot),
    ).toEqual([40, 100]);

    const replaced = service.copyMeals({
      sourceDate,
      targetDate,
      mealTypes: ['lunch'],
      replaceExisting: true,
    });
    const targetMeals = service.getDashboard(targetDate).meals;
    expect(replaced.copiedCount).toBe(1);
    expect(targetMeals.breakfast).toHaveLength(2);
    expect(targetMeals.lunch.map((meal) => meal.gramsSnapshot)).toEqual([120]);
    expect(targetMeals.dinner.map((meal) => meal.gramsSnapshot)).toEqual([60]);
  });

  it('食物修改并停用后仍使用原始营养快照复制历史餐次', () => {
    const originalInput = createFoodInput('历史快照食物', {
      caloriesPer100g: 200,
      proteinPer100g: 30,
    });
    const food = service.createFood(originalInput);
    service.createMealRecord({
      recordDate: '2026-07-04',
      mealType: 'dinner',
      foodId: food.id,
      amount: 80,
      unitType: 'gram',
    });
    service.updateFood(food.id, {
      ...originalInput,
      name: '已修改食物',
      caloriesPer100g: 50,
      proteinPer100g: 5,
    });
    service.archiveFood(food.id);

    service.copyMeals({
      sourceDate: '2026-07-04',
      targetDate: '2026-07-05',
      mealTypes: ['dinner'],
      replaceExisting: true,
    });
    expect(service.getDashboard('2026-07-05').meals.dinner).toEqual([
      expect.objectContaining({
        foodNameSnapshot: '历史快照食物',
        gramsSnapshot: 80,
        calories: 160,
        protein: 24,
      }),
    ]);
  });

  it('过去日期固定方案快照，切换方案会更新今天的快照', () => {
    const today = toLocalDateString(new Date());
    const yesterday = shiftDate(today, -1);
    const initialPlan = service.listDietPlans().find((plan) => plan.isActive);
    expect(initialPlan).toBeDefined();
    service.upsertBodyRecord({ recordDate: yesterday, weight: 70.5 });
    service.upsertBodyRecord({ recordDate: today, weight: 70.2 });

    const newPlan = service.createDietPlan({
      name: '今日切换方案',
      goalType: '减脂',
      targetCalories: 1800,
      targetProtein: 150,
      targetCarbs: 170,
      targetFat: 55,
      startDate: today,
    });
    service.activateDietPlan(newPlan.id);

    expect(service.getDashboard(today).activePlan?.id).toBe(newPlan.id);
    const history = service.listHistory({ startDate: yesterday, endDate: today });
    expect(history.find((day) => day.recordDate === yesterday)?.planId).toBe(initialPlan?.id);
    expect(history.find((day) => day.recordDate === today)?.planId).toBe(newPlan.id);
  });

  it('编辑当前方案只覆写今天快照，历史和非当前方案不受影响', () => {
    const today = toLocalDateString(new Date());
    const yesterday = shiftDate(today, -1);
    const activePlan = service.listDietPlans().find((plan) => plan.isActive);
    expect(activePlan).toBeDefined();
    if (!activePlan) {
      throw new Error('测试数据库缺少当前饮食方案');
    }
    service.upsertBodyRecord({ recordDate: yesterday, weight: 70.5 });
    service.upsertBodyRecord({ recordDate: today, weight: 70.2 });

    service.updateDietPlan(activePlan.id, {
      name: '编辑后的当前方案',
      goalType: activePlan.goalType,
      targetCalories: 2030,
      targetProtein: 140,
      targetCarbs: 210,
      targetFat: 70,
      startDate: activePlan.startDate,
      endDate: activePlan.endDate,
    });
    const historyAfterActiveUpdate = service.listHistory({ startDate: yesterday, endDate: today });
    expect(historyAfterActiveUpdate.find((day) => day.recordDate === yesterday)?.target).toEqual({
      calories: activePlan.calories,
      protein: activePlan.protein,
      carbs: activePlan.carbs,
      fat: activePlan.fat,
    });
    expect(historyAfterActiveUpdate.find((day) => day.recordDate === today)?.target).toEqual({
      calories: 2030,
      protein: 140,
      carbs: 210,
      fat: 70,
    });

    const inactivePlan = service.createDietPlan({
      name: '非当前方案',
      goalType: '自定义',
      targetCalories: 1800,
      targetProtein: 130,
      targetCarbs: 180,
      targetFat: 62,
      startDate: today,
    });
    service.updateDietPlan(inactivePlan.id, {
      name: '编辑后的非当前方案',
      goalType: '自定义',
      targetCalories: 1600,
      targetProtein: 120,
      targetCarbs: 150,
      targetFat: 58,
      startDate: today,
    });
    expect(service.getHistoryDay(today).summary.target).toEqual({
      calories: 2030,
      protein: 140,
      carbs: 210,
      fat: 70,
    });
  });

  it('历史汇总包含身体、营养和方案，并支持日期、方案及达标筛选', () => {
    const plan = service.createDietPlan({
      name: '历史筛选方案',
      goalType: '自定义',
      targetCalories: 100,
      targetProtein: 10,
      targetCarbs: 5,
      targetFat: 2,
      startDate: TEST_DATE,
    });
    service.activateDietPlan(plan.id);
    const food = service.createFood(createFoodInput('历史筛选食物'));
    const metDate = '2026-07-06';
    const missedDate = '2026-07-07';
    const bodyOnlyDate = '2026-07-08';
    service.upsertBodyRecord({
      recordDate: metDate,
      weight: 70,
      bodyFatPercentage: 18,
      waistCircumference: 78,
    });
    service.createMealRecord({
      recordDate: metDate,
      mealType: 'breakfast',
      foodId: food.id,
      amount: 100,
      unitType: 'gram',
    });
    service.createMealRecord({
      recordDate: missedDate,
      mealType: 'lunch',
      foodId: food.id,
      amount: 50,
      unitType: 'gram',
    });
    service.upsertBodyRecord({ recordDate: bodyOnlyDate, weight: 69.8 });

    const summaries = service.listHistory({ startDate: metDate, endDate: bodyOnlyDate });
    expect(summaries.map((day) => day.recordDate)).toEqual([bodyOnlyDate, missedDate, metDate]);
    expect(summaries.find((day) => day.recordDate === metDate)).toMatchObject({
      weight: 70,
      bodyFatPercentage: 18,
      waistCircumference: 78,
      planId: plan.id,
      planName: '历史筛选方案',
      nutrition: { calories: 100, protein: 10, carbs: 5, fat: 2 },
      mealCount: 1,
      meetsCalories: true,
      meetsProtein: true,
    });
    expect(summaries.find((day) => day.recordDate === missedDate)).toMatchObject({
      nutrition: { calories: 50, protein: 5, carbs: 2.5, fat: 1 },
      meetsCalories: false,
      meetsProtein: false,
    });

    expect(
      service.listHistory({
        startDate: metDate,
        endDate: bodyOnlyDate,
        planId: plan.id,
        calorieStatus: 'met',
      }),
    ).toEqual([expect.objectContaining({ recordDate: metDate })]);
    expect(
      service
        .listHistory({
          startDate: metDate,
          endDate: bodyOnlyDate,
          proteinStatus: 'not_met',
        })
        .map((day) => day.recordDate),
    ).toEqual([bodyOnlyDate, missedDate]);

    const detail = service.getHistoryDay(metDate);
    expect(detail.summary.recordDate).toBe(metDate);
    expect(detail.meals.breakfast).toEqual([
      expect.objectContaining({ foodNameSnapshot: '历史筛选食物', gramsSnapshot: 100 }),
    ]);
  });
});
