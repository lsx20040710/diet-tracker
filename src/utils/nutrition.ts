import type { NutritionProgress, NutritionTarget, NutritionValues } from '../types/models';

/** 将数据库计算结果稳定到四位小数，避免界面格式化反向污染累计值。 */
export function roundNutrition(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

/** 按实际克数换算每 100 克营养数据。 */
export function calculateNutritionByGrams(
  per100g: NutritionValues,
  grams: number,
): NutritionValues {
  if (!Number.isFinite(grams) || grams <= 0) {
    throw new Error('食用重量必须大于 0');
  }

  const ratio = grams / 100;
  return {
    calories: roundNutrition(per100g.calories * ratio),
    protein: roundNutrition(per100g.protein * ratio),
    carbs: roundNutrition(per100g.carbs * ratio),
    fat: roundNutrition(per100g.fat * ratio),
  };
}

/** 按份数和每份克数换算营养数据。 */
export function calculateNutritionByServing(
  per100g: NutritionValues,
  servings: number,
  servingGrams: number,
): NutritionValues {
  if (!Number.isFinite(servings) || servings <= 0) {
    throw new Error('份数必须大于 0');
  }
  if (!Number.isFinite(servingGrams) || servingGrams <= 0) {
    throw new Error('该食物没有有效的每份重量');
  }
  return calculateNutritionByGrams(per100g, servings * servingGrams);
}

/** 汇总营养数据，调用方决定哪些记录应计入统计。 */
export function sumNutrition(values: NutritionValues[]): NutritionValues {
  return values.reduce<NutritionValues>(
    (total, current) => ({
      calories: roundNutrition(total.calories + current.calories),
      protein: roundNutrition(total.protein + current.protein),
      carbs: roundNutrition(total.carbs + current.carbs),
      fat: roundNutrition(total.fat + current.fat),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

/** 生成剩余值；超过目标时保留负值，展示层据此显示“超出”。 */
export function createNutritionProgress(
  consumed: NutritionValues,
  target: NutritionTarget,
): NutritionProgress {
  return {
    consumed,
    target,
    remaining: {
      calories: roundNutrition(target.calories - consumed.calories),
      protein: roundNutrition(target.protein - consumed.protein),
      carbs: roundNutrition(target.carbs - consumed.carbs),
      fat: roundNutrition(target.fat - consumed.fat),
    },
  };
}

export function formatNutrition(value: number, digits = 1): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function calculateProgressPercent(consumed: number, target: number): number {
  if (target <= 0) {
    return consumed > 0 ? 100 : 0;
  }
  return Math.max(0, (consumed / target) * 100);
}
