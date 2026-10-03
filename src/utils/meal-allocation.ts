import {
  CORE_MEAL_TYPES,
  DEFAULT_MEAL_RATIOS,
  type CoreMealType,
  type DailyMealAllocation,
  type MealRatios,
  type NutritionMetric,
  type NutritionValues,
  type UnitType,
} from '../types/models';

export const NUTRITION_METRICS: readonly NutritionMetric[] = [
  'calories',
  'protein',
  'carbs',
  'fat',
];

export const NUTRITION_METRIC_LABELS: Record<NutritionMetric, string> = {
  calories: '热量',
  protein: '蛋白质',
  carbs: '碳水',
  fat: '脂肪',
};

interface DailyMealAllocationInput {
  target: NutritionValues;
  mealRatios: MealRatios;
  consumedByMeal: Record<CoreMealType, NutritionValues>;
  snackConsumed: NutritionValues;
  snackDeductedFrom: CoreMealType;
  indulgenceMealTypes?: readonly CoreMealType[];
}

export interface RecommendedMealAmount {
  amount: number;
  limitingMetric: NutritionMetric;
}

interface RecommendedMealAmountInput {
  nutritionPer100g: NutritionValues;
  remaining: NutritionValues;
  unitType: UnitType;
  servingGrams: number | null;
  unitName: string;
}

export function zeroNutrition(): NutritionValues {
  return { calories: 0, protein: 0, carbs: 0, fat: 0 };
}

export function roundNutrition(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function addNutrition(left: NutritionValues, right: NutritionValues): NutritionValues {
  return Object.fromEntries(
    NUTRITION_METRICS.map((metric) => [metric, roundNutrition(left[metric] + right[metric])]),
  ) as unknown as NutritionValues;
}

export function subtractNutrition(left: NutritionValues, right: NutritionValues): NutritionValues {
  return Object.fromEntries(
    NUTRITION_METRICS.map((metric) => [metric, roundNutrition(left[metric] - right[metric])]),
  ) as unknown as NutritionValues;
}

export function clampNutritionAtZero(nutrition: NutritionValues): NutritionValues {
  return Object.fromEntries(
    NUTRITION_METRICS.map((metric) => [metric, roundNutrition(Math.max(0, nutrition[metric]))]),
  ) as unknown as NutritionValues;
}

/** 无效旧数据回退到 4:3:3，避免某一餐因比例和为零失去目标。 */
export function normalizeMealRatios(ratios: MealRatios): MealRatios {
  const values = CORE_MEAL_TYPES.map((mealType) => ratios[mealType]);
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    values.reduce((sum, value) => sum + value, 0) <= 0
  ) {
    return { ...DEFAULT_MEAL_RATIOS };
  }
  return {
    breakfast: roundNutrition(ratios.breakfast),
    lunch: roundNutrition(ratios.lunch),
    dinner: roundNutrition(ratios.dinner),
  };
}

export function splitNutritionByMealRatios(
  target: NutritionValues,
  ratios: MealRatios,
): Record<CoreMealType, NutritionValues> {
  const normalizedRatios = normalizeMealRatios(ratios);
  const ratioTotal = CORE_MEAL_TYPES.reduce((sum, mealType) => sum + normalizedRatios[mealType], 0);
  return Object.fromEntries(
    CORE_MEAL_TYPES.map((mealType) => [
      mealType,
      Object.fromEntries(
        NUTRITION_METRICS.map((metric) => [
          metric,
          roundNutrition((target[metric] * normalizedRatios[mealType]) / ratioTotal),
        ]),
      ) as unknown as NutritionValues,
    ]),
  ) as unknown as Record<CoreMealType, NutritionValues>;
}

/** 前餐累计超额和加餐占用先扣除，剩余部分才是当前餐可用目标。 */
export function calculateAdjustedMealTarget(
  baseTarget: NutritionValues,
  carriedOver: NutritionValues,
  snackDeduction: NutritionValues,
): NutritionValues {
  return clampNutritionAtZero(
    subtractNutrition(subtractNutrition(baseTarget, carriedOver), snackDeduction),
  );
}

export function calculateCarryOver(
  baseTarget: NutritionValues,
  carriedOver: NutritionValues,
  snackDeduction: NutritionValues,
  consumed: NutritionValues,
): NutritionValues {
  return clampNutritionAtZero(
    subtractNutrition(
      addNutrition(addNutrition(carriedOver, snackDeduction), consumed),
      baseTarget,
    ),
  );
}

/**
 * 依次计算三餐动态目标；放纵餐消费量始终等于当时可用目标，因此不会自行制造额外超额。
 */
export function calculateDailyMealAllocation({
  target,
  mealRatios,
  consumedByMeal,
  snackConsumed,
  snackDeductedFrom,
  indulgenceMealTypes = [],
}: DailyMealAllocationInput): DailyMealAllocation {
  const normalizedRatios = normalizeMealRatios(mealRatios);
  const baseTargets = splitNutritionByMealRatios(target, normalizedRatios);
  const indulgenceMeals = new Set(indulgenceMealTypes);
  let carriedOver = zeroNutrition();

  const meals = Object.fromEntries(
    CORE_MEAL_TYPES.map((mealType) => {
      const snackDeduction =
        mealType === snackDeductedFrom ? { ...snackConsumed } : zeroNutrition();
      const adjustedTarget = calculateAdjustedMealTarget(
        baseTargets[mealType],
        carriedOver,
        snackDeduction,
      );
      const isIndulgence = indulgenceMeals.has(mealType);
      const consumed = isIndulgence ? adjustedTarget : consumedByMeal[mealType];
      const remaining = subtractNutrition(adjustedTarget, consumed);
      const overageToNext = calculateCarryOver(
        baseTargets[mealType],
        carriedOver,
        snackDeduction,
        consumed,
      );
      carriedOver = overageToNext;
      return [
        mealType,
        {
          mealType,
          baseTarget: baseTargets[mealType],
          target: adjustedTarget,
          consumed,
          remaining,
          overageToNext,
          snackDeduction,
          isIndulgence,
        },
      ];
    }),
  ) as unknown as DailyMealAllocation['meals'];

  return {
    mealRatios: normalizedRatios,
    meals,
    snack: { consumed: { ...snackConsumed }, deductedFrom: snackDeductedFrom },
  };
}

/**
 * 按热量和三大营养素中最先达到目标的一项向下取整，避免推荐值因显示精度反向超标。
 */
export function calculateRecommendedMealAmount({
  nutritionPer100g,
  remaining,
  unitType,
  servingGrams,
}: RecommendedMealAmountInput): RecommendedMealAmount | null {
  const gramsPerAmount = unitType === 'gram' ? 1 : servingGrams;
  if (!gramsPerAmount || !Number.isFinite(gramsPerAmount) || gramsPerAmount <= 0) return null;

  let limitingMetric: NutritionMetric | null = null;
  let rawAmount = Number.POSITIVE_INFINITY;
  for (const metric of NUTRITION_METRICS) {
    const contributionPerAmount = (nutritionPer100g[metric] * gramsPerAmount) / 100;
    if (!Number.isFinite(contributionPerAmount) || contributionPerAmount <= 0) continue;
    const candidate = remaining[metric] <= 0 ? 0 : remaining[metric] / contributionPerAmount;
    if (candidate < rawAmount) {
      rawAmount = candidate;
      limitingMetric = metric;
    }
  }
  if (limitingMetric === null || !Number.isFinite(rawAmount)) return null;

  const boundedAmount = Math.min(rawAmount, 1_000_000);
  const amount = Math.floor((boundedAmount + Number.EPSILON) * 10) / 10;
  if (amount < 0.1) return null;
  return { amount, limitingMetric };
}
