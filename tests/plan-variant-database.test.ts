import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseService } from '../electron/database';
import type { DietPlan, DietPlanInput, DietPlanVariantInput } from '../src/types/models';
import { shiftDate, toLocalDateString } from '../src/utils/date';

function createPlanInput(name: string, calories = 2_000): DietPlanInput {
  return {
    name,
    goalType: '自定义',
    targetCalories: calories,
    targetProtein: 120,
    targetCarbs: 240,
    targetFat: 62,
    startDate: '2026-08-01',
  };
}

function createVariantInput(plan: DietPlan, name: string, calories: number): DietPlanVariantInput {
  return {
    planId: plan.id,
    name,
    targetCalories: calories,
    targetProtein: 150,
    targetCarbs: 280,
    targetFat: 55,
    note: `${name}说明`,
  };
}

describe('饮食方案日型计划', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let service: DatabaseService;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'diet-tracker-plan-variant-test-'));
    databasePath = join(temporaryDirectory, 'diet-tracker.db');
    service = new DatabaseService(databasePath, '0.5.0-test');
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

  it('从 v5 升级到最新版时保留主方案、身体记录和原有目标快照', () => {
    const recordDate = '2026-08-03';
    const activePlan = service.listDietPlans().find((plan) => plan.isActive);
    expect(activePlan).toBeDefined();
    service.upsertBodyRecord({ recordDate, weight: 70.2 });
    const targetBeforeUpgrade = service.getDashboard(recordDate).nutrition.target;
    const planCount = service.listDietPlans().length;
    service.close();

    // 还原真实 v5 结构，验证新增标签表和可空快照列不会改写旧数据。
    const versionFiveDatabase = new DatabaseSync(databasePath);
    versionFiveDatabase.exec(`
      DROP INDEX idx_daily_plan_snapshots_variant_date;
      ALTER TABLE daily_plan_snapshots DROP COLUMN variant_name;
      ALTER TABLE daily_plan_snapshots DROP COLUMN variant_id;
      DROP TABLE diet_plan_variants;
      DELETE FROM schema_migrations WHERE version = 6;
      PRAGMA user_version = 5;
    `);
    versionFiveDatabase.close();

    service = new DatabaseService(databasePath, '0.5.0-test');
    service.initialize();
    expect(service.getAppInfo().databaseVersion).toBe(10);
    expect(service.listDietPlans()).toHaveLength(planCount);
    expect(service.listBodyRecords()).toEqual([
      expect.objectContaining({ recordDate, weight: 70.2 }),
    ]);
    expect(service.getDashboard(recordDate)).toMatchObject({
      dailyPlan: {
        planId: activePlan?.id,
        variantId: null,
        variantName: null,
        target: targetBeforeUpgrade,
      },
      nutrition: { target: targetBeforeUpgrade },
    });
    expect(service.listDietPlanVariants(activePlan?.id ?? 0)).toEqual([]);

    service.close();
    service = new DatabaseService(databasePath, '0.5.0-test');
    service.initialize();
    expect(service.listDietPlanVariants(activePlan?.id ?? 0)).toEqual([]);
    service.close();

    const inspectionDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const migrationCount = inspectionDatabase
      .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6')
      .get() as { count: number };
    inspectionDatabase.close();
    expect(Number(migrationCount.count)).toBe(1);

    service = new DatabaseService(databasePath, '0.5.0-test');
    service.initialize();
  });

  it('v7 日型升级后保留目标，并将未知计算来源标记为手动填写', () => {
    const activePlan = service.listDietPlans().find((plan) => plan.isActive);
    if (!activePlan) throw new Error('测试数据库缺少当前饮食方案');
    const legacyVariant = service.createDietPlanVariant(
      createVariantInput(activePlan, '旧版训练日', 2_300),
    );
    service.close();

    const versionSevenDatabase = new DatabaseSync(databasePath);
    versionSevenDatabase.exec(`
      ALTER TABLE diet_plan_variants DROP COLUMN fat_per_kg;
      ALTER TABLE diet_plan_variants DROP COLUMN carbs_per_kg;
      ALTER TABLE diet_plan_variants DROP COLUMN protein_per_kg;
      ALTER TABLE diet_plan_variants DROP COLUMN weight_source_date;
      ALTER TABLE diet_plan_variants DROP COLUMN calculation_weight;
      ALTER TABLE diet_plan_variants DROP COLUMN calculation_mode;
      DELETE FROM schema_migrations WHERE version = 8;
      PRAGMA user_version = 7;
    `);
    versionSevenDatabase.close();

    service = new DatabaseService(databasePath, '0.5.0-test');
    service.initialize();
    expect(service.getAppInfo().databaseVersion).toBe(10);
    expect(service.listDietPlanVariants(activePlan.id)).toEqual([
      expect.objectContaining({
        id: legacyVariant.id,
        name: '旧版训练日',
        calories: 2_300,
        calculationMode: 'manual',
        calculationWeight: null,
        weightSourceDate: null,
        proteinPerKg: null,
        carbsPerKg: null,
        fatPerKg: null,
      }),
    ]);
  });

  it('日型支持按方案新增、读取、编辑和删除，且同方案名称不区分大小写', () => {
    const firstPlan = service.listDietPlans().find((plan) => plan.isActive);
    expect(firstPlan).toBeDefined();
    if (!firstPlan) throw new Error('测试数据库缺少当前饮食方案');
    const secondPlan = service.createDietPlan(createPlanInput('第二主方案', 1_800));

    const training = service.createDietPlanVariant({
      ...createVariantInput(firstPlan, '训练日', 2_300),
      calculationMode: 'weight_based',
      weightSourceMode: 'manual',
      calculationWeight: 70,
      weightSourceDate: null,
      proteinPerKg: 2.2,
      carbsPerKg: 4,
      fatPerKg: 0.8,
    });
    const rest = service.createDietPlanVariant({
      ...createVariantInput(firstPlan, '休息日', 1_900),
      calculationMode: 'weight_based',
      weightSourceMode: 'manual',
      calculationWeight: 69.5,
      weightSourceDate: null,
      proteinPerKg: 1.8,
      carbsPerKg: 2,
      fatPerKg: 1,
    });
    const secondPlanTag = service.createDietPlanVariant(
      createVariantInput(secondPlan, '训练日', 2_100),
    );

    expect(service.listDietPlanVariants(firstPlan.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: training.id,
          planId: firstPlan.id,
          name: '训练日',
          calculationMode: 'weight_based',
          calculationWeight: 70,
          carbsPerKg: 4,
        }),
        expect.objectContaining({
          id: rest.id,
          planId: firstPlan.id,
          name: '休息日',
          calculationMode: 'weight_based',
          calculationWeight: 69.5,
          carbsPerKg: 2,
        }),
      ]),
    );
    expect(service.listDietPlanVariants(secondPlan.id)).toEqual([
      expect.objectContaining({ id: secondPlanTag.id, planId: secondPlan.id, name: '训练日' }),
    ]);

    const updated = service.updateDietPlanVariant(training.id, {
      name: '训练日·高碳',
      targetCalories: 2_450,
      targetProtein: 155,
      targetCarbs: 320,
      targetFat: 52,
      calculationMode: 'weight_based',
      weightSourceMode: 'manual',
      calculationWeight: 70,
      weightSourceDate: null,
      proteinPerKg: 2.3,
      carbsPerKg: 4.5,
      fatPerKg: 0.75,
      note: '更新后的标签',
    });
    expect(updated).toMatchObject({
      id: training.id,
      planId: firstPlan.id,
      name: '训练日·高碳',
      calories: 2_450,
      protein: 155,
      carbs: 320,
      fat: 52,
      calculationMode: 'weight_based',
      calculationWeight: 70,
      proteinPerKg: 2.3,
      carbsPerKg: 4.5,
      fatPerKg: 0.75,
      note: '更新后的标签',
    });
    expect(() =>
      service.createDietPlanVariant(createVariantInput(firstPlan, '休息日', 1_850)),
    ).toThrow(/重复的日型名称/);

    const copiedPlan = service.duplicateDietPlan(
      firstPlan.id,
      createPlanInput('包含标签的方案副本', 2_050),
    );
    const copiedVariants = service.listDietPlanVariants(copiedPlan.id);
    expect(copiedPlan).toMatchObject({
      name: '包含标签的方案副本',
      calories: 2_050,
      protein: 120,
      carbs: 240,
      fat: 62,
    });
    expect(copiedVariants).toHaveLength(2);
    expect(copiedVariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planId: copiedPlan.id,
          name: '训练日·高碳',
          calories: 2_450,
          calculationMode: 'weight_based',
          proteinPerKg: 2.3,
          carbsPerKg: 4.5,
          note: '更新后的标签',
        }),
        expect.objectContaining({
          planId: copiedPlan.id,
          name: '休息日',
          calories: 1_900,
          calculationMode: 'weight_based',
          calculationWeight: 69.5,
          carbsPerKg: 2,
        }),
      ]),
    );
    expect(copiedVariants.map((variant) => variant.id)).not.toContain(training.id);

    const copiedTraining = copiedVariants.find((variant) => variant.name === '训练日·高碳');
    if (!copiedTraining) throw new Error('复制方案缺少训练日标签');
    service.updateDietPlanVariant(copiedTraining.id, {
      name: '副本专用训练日',
      targetCalories: 2_700,
      targetProtein: 180,
      targetCarbs: 350,
      targetFat: 60,
      note: '仅修改副本',
    });
    expect(service.listDietPlanVariants(firstPlan.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: training.id, name: '训练日·高碳', calories: 2_450 }),
      ]),
    );

    service.deleteDietPlanVariant(rest.id);
    expect(service.listDietPlanVariants(firstPlan.id).map((variant) => variant.id)).not.toContain(
      rest.id,
    );
    expect(service.listDietPlanVariants(copiedPlan.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '休息日', calories: 1_900 })]),
    );
  });

  it('不同日期可选择不同日型，未单独选择或重置时采用首个日型', () => {
    const activePlan = service.listDietPlans().find((plan) => plan.isActive);
    expect(activePlan).toBeDefined();
    if (!activePlan) throw new Error('测试数据库缺少当前饮食方案');
    const highCarb = service.createDietPlanVariant(createVariantInput(activePlan, '高碳日', 2_400));
    const lowCarb = service.createDietPlanVariant(createVariantInput(activePlan, '低碳日', 1_700));
    const highCarbDate = '2026-08-04';
    const lowCarbDate = '2026-08-05';
    const unselectedDate = '2026-08-06';

    expect(service.getDashboard(unselectedDate)).toMatchObject({
      dailyPlan: null,
      nutrition: { target: { calories: 2_400, protein: 150, carbs: 280, fat: 55 } },
    });
    service.upsertBodyRecord({ recordDate: unselectedDate, weight: 70 });
    expect(service.getDashboard(unselectedDate).dailyPlan).toMatchObject({
      variantId: highCarb.id,
      variantName: '高碳日',
    });

    service.setDailyPlanVariant({ recordDate: highCarbDate, variantId: highCarb.id });
    service.setDailyPlanVariant({ recordDate: lowCarbDate, variantId: lowCarb.id });

    expect(service.getDashboard(highCarbDate)).toMatchObject({
      dailyPlan: { variantId: highCarb.id, variantName: '高碳日' },
      nutrition: { target: { calories: 2_400 } },
    });
    expect(service.getDashboard(lowCarbDate)).toMatchObject({
      dailyPlan: { variantId: lowCarb.id, variantName: '低碳日' },
      nutrition: { target: { calories: 1_700 } },
    });

    const cleared = service.clearDailyPlanVariant(highCarbDate);
    expect(cleared).toMatchObject({
      recordDate: highCarbDate,
      planId: activePlan.id,
      variantId: highCarb.id,
      variantName: '高碳日',
      target: {
        calories: highCarb.calories,
        protein: highCarb.protein,
        carbs: highCarb.carbs,
        fat: highCarb.fat,
      },
    });
    expect(service.getDashboard(lowCarbDate).dailyPlan).toMatchObject({
      variantId: lowCarb.id,
      variantName: '低碳日',
    });
  });

  it('最新体重刷新自动日型的今天目标，历史快照与手动体重保持不变', () => {
    const activePlan = service.listDietPlans().find((plan) => plan.isActive);
    if (!activePlan) throw new Error('测试数据库缺少当前饮食方案');
    const today = toLocalDateString(new Date());
    const historyDate = shiftDate(today, -1);
    service.upsertBodyRecord({ recordDate: historyDate, weight: 70 });
    const automaticVariant = service.createDietPlanVariant({
      ...createVariantInput(activePlan, '自动训练日', 2_030),
      targetProtein: 140,
      targetCarbs: 210,
      targetFat: 70,
      calculationMode: 'weight_based',
      weightSourceMode: 'latest',
      calculationWeight: 70,
      weightSourceDate: historyDate,
      proteinPerKg: 2,
      carbsPerKg: 3,
      fatPerKg: 1,
    });
    const manualVariant = service.createDietPlanVariant({
      ...createVariantInput(activePlan, '手动训练日', 2_030),
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
    });
    service.setDailyPlanVariant({ recordDate: historyDate, variantId: automaticVariant.id });
    service.setDailyPlanVariant({ recordDate: today, variantId: automaticVariant.id });

    service.importBodyRecords([{ recordDate: today, weight: 72 }]);
    expect(service.listDietPlanVariants(activePlan.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: automaticVariant.id,
          weightSourceMode: 'latest',
          calculationWeight: 72,
          weightSourceDate: today,
          calories: 2088,
          protein: 144,
          carbs: 216,
          fat: 72,
        }),
        expect.objectContaining({
          id: manualVariant.id,
          weightSourceMode: 'manual',
          calculationWeight: 70,
          weightSourceDate: null,
          calories: 2030,
          protein: 140,
          carbs: 210,
          fat: 70,
        }),
      ]),
    );
    expect(service.getDashboard(today).nutrition.target).toEqual({
      calories: 2088,
      protein: 144,
      carbs: 216,
      fat: 72,
    });
    expect(service.getHistoryDay(historyDate).summary).toMatchObject({
      variantName: '自动训练日',
      target: { calories: 2030, protein: 140, carbs: 210, fat: 70 },
    });
  });

  it('删除日型后保留历史名称与目标快照，编辑日型也不暗改过去日期', () => {
    const activePlan = service.listDietPlans().find((plan) => plan.isActive);
    expect(activePlan).toBeDefined();
    if (!activePlan) throw new Error('测试数据库缺少当前饮食方案');
    const pastDate = '2026-08-06';
    const today = toLocalDateString(new Date());
    const variant = service.createDietPlanVariant(
      createVariantInput(activePlan, '历史训练日', 2_350),
    );
    service.upsertBodyRecord({ recordDate: pastDate, weight: 69.8 });
    service.setDailyPlanVariant({ recordDate: pastDate, variantId: variant.id });
    service.setDailyPlanVariant({ recordDate: today, variantId: variant.id });

    const updatedVariant = service.updateDietPlanVariant(variant.id, {
      name: '修改后的训练日',
      targetCalories: 2_600,
      targetProtein: 170,
      targetCarbs: 340,
      targetFat: 60,
      note: '新版模板',
    });
    expect(service.getHistoryDay(pastDate).summary).toMatchObject({
      variantName: '历史训练日',
      target: { calories: 2_350, protein: 150, carbs: 280, fat: 55 },
    });
    expect(service.getDashboard(today).dailyPlan).toMatchObject({
      variantId: updatedVariant.id,
      variantName: '修改后的训练日',
      target: { calories: 2_600, protein: 170, carbs: 340, fat: 60 },
    });

    const renamedPlan = service.updateDietPlan(activePlan.id, {
      name: `${activePlan.name}（修改基础目标）`,
      goalType: activePlan.goalType,
      targetCalories: 1_600,
      targetProtein: 100,
      targetCarbs: 180,
      targetFat: 53,
      startDate: activePlan.startDate,
      endDate: activePlan.endDate,
      note: activePlan.note,
    });
    // 编辑当前主方案只改变基础目标，今天显式选择的标签仍然优先。
    expect(service.getDashboard(today).dailyPlan).toMatchObject({
      planId: activePlan.id,
      planName: renamedPlan.name,
      variantId: updatedVariant.id,
      variantName: '修改后的训练日',
      target: { calories: 2_600, protein: 170, carbs: 340, fat: 60 },
    });
    expect(service.getHistoryDay(pastDate).summary).toMatchObject({
      planName: activePlan.name,
      variantName: '历史训练日',
      target: { calories: 2_350, protein: 150, carbs: 280, fat: 55 },
    });

    service.deleteDietPlanVariant(variant.id);
    const renamedAfterVariantDeletion = service.updateDietPlan(activePlan.id, {
      name: `${renamedPlan.name}（再次改名）`,
      goalType: renamedPlan.goalType,
      targetCalories: renamedPlan.calories,
      targetProtein: renamedPlan.protein,
      targetCarbs: renamedPlan.carbs,
      targetFat: renamedPlan.fat,
      startDate: renamedPlan.startDate,
      endDate: renamedPlan.endDate,
      note: renamedPlan.note,
    });
    // 已删除标签仍保留名称和目标，但主方案名应同步到当天最新名称。
    expect(service.getDashboard(today).dailyPlan).toMatchObject({
      planId: activePlan.id,
      planName: renamedAfterVariantDeletion.name,
      variantId: null,
      variantName: '修改后的训练日',
      target: { calories: 2_600, protein: 170, carbs: 340, fat: 60 },
    });
    expect(service.getHistoryDay(pastDate).summary).toMatchObject({
      planId: activePlan.id,
      planName: activePlan.name,
      variantName: '历史训练日',
      target: { calories: 2_350, protein: 150, carbs: 280, fat: 55 },
    });
    expect(service.getDashboard(pastDate).dailyPlan).toMatchObject({
      variantId: null,
      variantName: '历史训练日',
      target: { calories: 2_350, protein: 150, carbs: 280, fat: 55 },
    });
  });

  it('切换方案时清除当天旧日型，且拒绝跨方案日型和负目标', () => {
    const today = toLocalDateString(new Date());
    const yesterday = shiftDate(today, -1);
    const firstPlan = service.listDietPlans().find((plan) => plan.isActive);
    expect(firstPlan).toBeDefined();
    if (!firstPlan) throw new Error('测试数据库缺少当前饮食方案');
    const oldVariant = service.createDietPlanVariant(
      createVariantInput(firstPlan, '旧方案训练日', 2_300),
    );
    service.upsertBodyRecord({ recordDate: yesterday, weight: 70.1 });
    service.setDailyPlanVariant({ recordDate: yesterday, variantId: oldVariant.id });
    service.setDailyPlanVariant({ recordDate: today, variantId: oldVariant.id });

    const secondPlan = service.createDietPlan(createPlanInput('新主方案', 1_750));
    service.activateDietPlan(secondPlan.id);
    expect(service.getDashboard(today)).toMatchObject({
      activePlan: { id: secondPlan.id },
      dailyPlan: { planId: secondPlan.id, variantId: null, variantName: null },
      nutrition: { target: { calories: 1_750 } },
    });
    expect(service.getHistoryDay(yesterday).summary).toMatchObject({
      planId: firstPlan.id,
      variantName: '旧方案训练日',
      target: { calories: 2_300 },
    });
    const clearedHistoricalSelection = service.clearDailyPlanVariant(yesterday);
    expect(clearedHistoricalSelection).toMatchObject({
      planId: secondPlan.id,
      planName: secondPlan.name,
      variantId: null,
      variantName: null,
      target: {
        calories: secondPlan.calories,
        protein: secondPlan.protein,
        carbs: secondPlan.carbs,
        fat: secondPlan.fat,
      },
    });
    expect(() =>
      service.setDailyPlanVariant({ recordDate: today, variantId: oldVariant.id }),
    ).toThrow(/当前饮食方案下的日型计划/);
    expect(() =>
      service.createDietPlanVariant({
        ...createVariantInput(secondPlan, '非法负目标', 1_800),
        targetFat: -1,
      }),
    ).toThrow(/脂肪目标/);
    expect(() =>
      service.createDietPlanVariant({
        ...createVariantInput(secondPlan, '非法系数', 1_800),
        calculationMode: 'weight_based',
        weightSourceMode: 'manual',
        calculationWeight: 70,
        weightSourceDate: null,
        proteinPerKg: 2,
        carbsPerKg: 21,
        fatPerKg: 1,
      }),
    ).toThrow(/碳水系数/);
  });
});
