import type { BodyRecord } from '../types/models';
import { roundNutrition } from './nutrition';

export const DEFAULT_PROTEIN_PER_KG = 2;
export const DEFAULT_CARBS_PER_KG = 3;
export const DEFAULT_FAT_PER_KG = 1;

export type ValidWeightRecord = BodyRecord & { weight: number };

export interface WeightBasedPlanInput {
  weight: number;
  proteinPerKg: number;
  carbsPerKg: number;
  fatPerKg: number;
}

export interface WeightBasedPlanResult {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

const MAX_COEFFICIENT = 20;
const MAX_WEIGHT_KG = 1_000;

/** 返回可用于系数计算的体重记录，并按日期从新到旧排序。 */
export function getValidWeightRecords(bodyRecords: BodyRecord[]): ValidWeightRecord[] {
  return bodyRecords
    .filter(
      (record): record is ValidWeightRecord =>
        record.weight !== null && Number.isFinite(record.weight) && record.weight > 0,
    )
    .slice()
    .sort((left, right) => right.recordDate.localeCompare(left.recordDate));
}

/**
 * 按体重和每公斤系数生成营养目标。
 * 无效体重、非有限数值或越界系数会被拒绝，避免把错误目标写入方案。
 */
export function calculateWeightBasedPlan(input: WeightBasedPlanInput): WeightBasedPlanResult {
  if (!Number.isFinite(input.weight) || input.weight <= 0 || input.weight > MAX_WEIGHT_KG) {
    throw new Error('请选择一条包含有效体重的身体记录');
  }

  const coefficients = [input.proteinPerKg, input.carbsPerKg, input.fatPerKg];
  if (
    coefficients.some(
      (coefficient) =>
        !Number.isFinite(coefficient) || coefficient < 0 || coefficient > MAX_COEFFICIENT,
    )
  ) {
    throw new Error('每公斤营养系数必须是 0 到 20 之间的数字');
  }

  const rawProtein = input.weight * input.proteinPerKg;
  const rawCarbs = input.weight * input.carbsPerKg;
  const rawFat = input.weight * input.fatPerKg;

  return {
    // 热量直接使用未舍入宏量，避免把三次中间舍入误差再次累计。
    calories: roundNutrition(rawProtein * 4 + rawCarbs * 4 + rawFat * 9),
    protein: roundNutrition(rawProtein),
    carbs: roundNutrition(rawCarbs),
    fat: roundNutrition(rawFat),
  };
}
