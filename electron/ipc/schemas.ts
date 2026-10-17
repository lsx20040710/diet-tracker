import { z } from 'zod';

import {
  CHART_CSV_LIMITS,
  CHART_IMAGE_FORMATS,
  CORE_MEAL_TYPES,
  DIET_PLAN_CALCULATION_MODES,
  DIET_PLAN_WEIGHT_SOURCE_MODES,
  ENERGY_UNITS,
  EXPORT_DATA_KINDS,
  FOOD_CATEGORIES,
  FOOD_KINDS,
  FOOD_SCOPES,
  GOAL_FILTERS,
  GOAL_TYPES,
  IMPORT_DATA_KINDS,
  MEAL_TYPES,
  SUPPLEMENT_FREQUENCIES,
  SUPPLEMENT_WEEKDAYS,
  UNIT_TYPES,
} from '../../src/types/models';

const isRealDate = (value: string): boolean => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD')
  .refine(isRealDate, '日期无效');

export const idSchema = z.number().int('ID 必须为整数').positive('ID 必须大于 0');

export const appSettingsSchema = z
  .object({
    defaultEnergyUnit: z.enum(ENERGY_UNITS, { error: '默认热量单位必须是 kcal 或 kJ' }),
  })
  .strict();

export const dataStorageChangeInputSchema = z
  .object({
    selectionId: z.string().uuid('请重新选择数据目录'),
    mode: z.enum(['migrate', 'existing']),
  })
  .strict();

const optionalText = (maximum: number) => z.string().trim().max(maximum).optional();
const nullablePositive = (label: string, maximum: number) =>
  z
    .number({ error: `${label}必须是数字` })
    .finite(`${label}必须是有限数字`)
    .positive(`${label}必须大于 0`)
    .max(maximum, `${label}超出允许范围`)
    .nullable()
    .optional();

export const bodyRecordInputSchema = z.object({
  recordDate: dateSchema,
  weight: nullablePositive('体重', 1_000),
  bodyFatPercentage: z
    .number({ error: '体脂率必须是数字' })
    .finite('体脂率必须是有限数字')
    .min(0, '体脂率不能小于 0')
    .max(100, '体脂率不能大于 100')
    .nullable()
    .optional(),
  waistCircumference: nullablePositive('腰围', 1_000),
  note: optionalText(1_000),
});

const nutritionNumber = (label: string) =>
  z
    .number({ error: `${label}必须是数字` })
    .finite(`${label}必须是有限数字`)
    .min(0, `${label}不能为负数`)
    .max(100_000, `${label}超出允许范围`);

export const foodInputSchema = z
  .object({
    name: z.string().trim().min(1, '食物名称不能为空').max(100, '食物名称不能超过 100 个字符'),
    brand: optionalText(100),
    category: z.enum(FOOD_CATEGORIES, { error: '食物分类无效' }),
    caloriesPer100g: nutritionNumber('每 100 克热量'),
    proteinPer100g: nutritionNumber('每 100 克蛋白质'),
    carbsPer100g: nutritionNumber('每 100 克碳水'),
    fatPer100g: nutritionNumber('每 100 克脂肪'),
    defaultServingGrams: z
      .number({ error: '默认每份重量必须是数字' })
      .finite('默认每份重量必须是有限数字')
      .positive('默认每份重量必须大于 0')
      .max(100_000, '默认每份重量超出允许范围')
      .nullable()
      .optional(),
    unitName: z.string().trim().min(1).max(20).optional(),
    isSupplement: z.boolean().optional(),
    countInNutrition: z.boolean().optional(),
    isFavorite: z.boolean().optional(),
    isRecommendable: z.boolean().optional(),
    supplementFrequency: z.enum(SUPPLEMENT_FREQUENCIES).optional(),
    supplementWeekdays: z
      .array(z.enum(SUPPLEMENT_WEEKDAYS))
      .max(SUPPLEMENT_WEEKDAYS.length)
      .refine((weekdays) => new Set(weekdays).size === weekdays.length, '服用星期不能重复')
      .optional(),
    supplementDosage: nullablePositive('每次用量', 1_000_000),
    supplementDosageUnit: z.enum(UNIT_TYPES, { error: '补剂用量单位无效' }).optional(),
    note: optionalText(1_000),
  })
  .superRefine((input, context) => {
    const isSupplement = input.isSupplement === true || input.category === '补剂';
    const frequency = input.supplementFrequency ?? 'as_needed';
    const dosage = input.supplementDosage ?? null;
    const dosageUnit = input.supplementDosageUnit ?? 'gram';

    if (
      !isSupplement &&
      (frequency !== 'as_needed' ||
        (input.supplementWeekdays?.length ?? 0) > 0 ||
        dosage !== null ||
        dosageUnit !== 'gram')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['supplementFrequency'],
        message: '只有补剂可以设置服用频率和用量',
      });
    }
    if (frequency === 'weekdays' && (input.supplementWeekdays?.length ?? 0) === 0) {
      context.addIssue({
        code: 'custom',
        path: ['supplementWeekdays'],
        message: '按星期服用时请至少选择一天',
      });
    }
    if (frequency !== 'as_needed' && dosage === null) {
      context.addIssue({
        code: 'custom',
        path: ['supplementDosage'],
        message: '加入当日推荐前必须填写每次用量',
      });
    }
    if (dosage !== null && dosageUnit === 'serving' && !input.defaultServingGrams) {
      context.addIssue({
        code: 'custom',
        path: ['defaultServingGrams'],
        message: '按份设置补剂用量前必须填写默认每份重量',
      });
    }
  });

export const foodQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    category: z.union([z.literal('全部'), z.enum(FOOD_CATEGORIES)]).optional(),
    scope: z.enum(FOOD_SCOPES, { error: '食物列表范围无效' }).optional(),
    kind: z.enum(FOOD_KINDS, { error: '食物类型筛选条件无效' }).optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .optional();

export const mealRecordInputSchema = z.object({
  recordDate: dateSchema,
  mealType: z.enum(MEAL_TYPES, { error: '餐次类型无效' }),
  foodId: idSchema,
  amount: z
    .number({ error: '食用数量必须是数字' })
    .finite('食用数量必须是有限数字')
    .positive('食用数量必须大于 0')
    .max(1_000_000, '食用数量超出允许范围'),
  unitType: z.enum(UNIT_TYPES, { error: '记录单位无效' }),
  amountMode: z.enum(['manual', 'recommended']).optional(),
  note: optionalText(1_000),
});

export const mealRecordUpdateSchema = z.object({
  id: idSchema,
  amount: z
    .number({ error: '食用数量必须是数字' })
    .finite('食用数量必须是有限数字')
    .positive('食用数量必须大于 0')
    .max(1_000_000, '食用数量超出允许范围'),
  unitType: z.enum(UNIT_TYPES, { error: '记录单位无效' }),
  note: optionalText(1_000),
});

export const clearMealSchema = z.object({
  date: dateSchema,
  mealType: z.enum(MEAL_TYPES, { error: '餐次类型无效' }),
});

export const reorderMealSchema = z
  .array(idSchema)
  .min(1, '排序记录不能为空')
  .max(500, '一次最多调整 500 条记录')
  .refine((ids) => new Set(ids).size === ids.length, '排序记录中不能包含重复 ID');

const dietPlanCalculationFields = {
  calculationMode: z.enum(DIET_PLAN_CALCULATION_MODES).default('manual'),
  weightSourceMode: z.enum(DIET_PLAN_WEIGHT_SOURCE_MODES).default('latest'),
  calculationWeight: z
    .number()
    .finite('采用体重必须是有限数字')
    .positive()
    .max(1_000, '采用体重不能超过 1000 kg')
    .nullable()
    .optional(),
  weightSourceDate: dateSchema.nullable().optional(),
  proteinPerKg: z.number().finite('蛋白质系数必须是有限数字').min(0).max(20).nullable().optional(),
  carbsPerKg: z.number().finite('碳水系数必须是有限数字').min(0).max(20).nullable().optional(),
  fatPerKg: z.number().finite('脂肪系数必须是有限数字').min(0).max(20).nullable().optional(),
};

const mealRatiosSchema = z
  .object({
    breakfast: z.number().finite('早餐比例必须是有限数字').min(0).max(1_000),
    lunch: z.number().finite('午餐比例必须是有限数字').min(0).max(1_000),
    dinner: z.number().finite('晚餐比例必须是有限数字').min(0).max(1_000),
  })
  .refine((ratios) => ratios.breakfast + ratios.lunch + ratios.dinner > 0, {
    message: '早餐、午餐和晚餐的分配比例不能全部为 0',
  })
  .optional();

interface DietPlanCalculationCandidate {
  calculationMode: (typeof DIET_PLAN_CALCULATION_MODES)[number];
  weightSourceMode: (typeof DIET_PLAN_WEIGHT_SOURCE_MODES)[number];
  calculationWeight?: number | null;
  weightSourceDate?: string | null;
  proteinPerKg?: number | null;
  carbsPerKg?: number | null;
  fatPerKg?: number | null;
}

/** 自动来源必须绑定最新记录日期，手动来源不保留过期的记录日期。 */
function validateDietPlanCalculation(
  calculation: DietPlanCalculationCandidate,
  context: z.RefinementCtx,
): void {
  if (calculation.calculationMode !== 'weight_based') return;
  const requiredFields: Array<[string, unknown, string]> = [
    ['calculationWeight', calculation.calculationWeight, '采用体重'],
    ['proteinPerKg', calculation.proteinPerKg, '蛋白质系数'],
    ['carbsPerKg', calculation.carbsPerKg, '碳水系数'],
    ['fatPerKg', calculation.fatPerKg, '脂肪系数'],
  ];
  if (calculation.weightSourceMode === 'latest') {
    requiredFields.splice(1, 0, ['weightSourceDate', calculation.weightSourceDate, '体重记录日期']);
  } else if (calculation.weightSourceDate !== null && calculation.weightSourceDate !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['weightSourceDate'],
      message: '手动输入体重时不能绑定体重记录日期',
    });
  }
  for (const [path, value, label] of requiredFields) {
    if (value === null || value === undefined) {
      context.addIssue({ code: 'custom', path: [path], message: `${label}不能为空` });
    }
  }
}

export const dietPlanInputSchema = z
  .object({
    name: z.string().trim().min(1, '方案名称不能为空').max(100),
    goalType: z.enum(GOAL_TYPES, { error: '目标类型无效' }),
    targetCalories: nutritionNumber('热量目标'),
    targetProtein: nutritionNumber('蛋白质目标'),
    targetCarbs: nutritionNumber('碳水目标'),
    targetFat: nutritionNumber('脂肪目标'),
    mealRatios: mealRatiosSchema,
    ...dietPlanCalculationFields,
    startDate: dateSchema,
    endDate: dateSchema.nullable().optional(),
    note: optionalText(1_000),
  })
  .refine((plan) => !plan.endDate || plan.endDate >= plan.startDate, {
    message: '结束日期不能早于开始日期',
    path: ['endDate'],
  })
  .superRefine(validateDietPlanCalculation);

export const updateFoodPayloadSchema = z.object({
  id: idSchema,
  input: foodInputSchema,
});

export const updateDietPlanPayloadSchema = z.object({
  id: idSchema,
  input: dietPlanInputSchema,
});

export const duplicateDietPlanPayloadSchema = z.object({
  id: idSchema,
  input: dietPlanInputSchema,
});

const dietPlanVariantTargetSchema = {
  name: z.string().trim().min(1, '日型名称不能为空').max(100, '日型名称不能超过 100 个字符'),
  targetCalories: nutritionNumber('热量目标'),
  targetProtein: nutritionNumber('蛋白质目标'),
  targetCarbs: nutritionNumber('碳水目标'),
  targetFat: nutritionNumber('脂肪目标'),
  ...dietPlanCalculationFields,
  note: optionalText(1_000),
};

export const dietPlanVariantInputSchema = z
  .object({
    planId: idSchema,
    ...dietPlanVariantTargetSchema,
  })
  .superRefine(validateDietPlanCalculation);

export const dietPlanVariantUpdateInputSchema = z
  .object(dietPlanVariantTargetSchema)
  .superRefine(validateDietPlanCalculation);

export const updateDietPlanVariantPayloadSchema = z.object({
  id: idSchema,
  input: dietPlanVariantUpdateInputSchema,
});

export const setDailyPlanVariantInputSchema = z.object({
  recordDate: dateSchema,
  variantId: idSchema,
});

export const setMealIndulgenceInputSchema = z.object({
  recordDate: dateSchema,
  mealType: z.enum(CORE_MEAL_TYPES, { error: '放纵餐餐次无效' }),
  enabled: z.boolean({ error: '放纵餐状态必须是布尔值' }),
});

export const setFoodFavoritePayloadSchema = z.object({
  id: idSchema,
  isFavorite: z.boolean({ error: '收藏状态必须是布尔值' }),
});

const foodCombinationItemInputSchema = z.object({
  foodId: idSchema,
  amount: z
    .number({ error: '组合食物数量必须是数字' })
    .finite('组合食物数量必须是有限数字')
    .positive('组合食物数量必须大于 0')
    .max(1_000_000, '组合食物数量超出允许范围'),
  unitType: z.enum(UNIT_TYPES, { error: '组合食物单位无效' }),
});

export const foodCombinationInputSchema = z.object({
  name: z.string().trim().min(1, '组合名称不能为空').max(100, '组合名称不能超过 100 个字符'),
  description: optionalText(1_000),
  items: z
    .array(foodCombinationItemInputSchema)
    .min(1, '常用组合至少需要一种食物')
    .max(100, '一个常用组合最多包含 100 种食物'),
});

export const updateFoodCombinationPayloadSchema = z.object({
  id: idSchema,
  input: foodCombinationInputSchema,
});

export const addCombinationToMealInputSchema = z.object({
  combinationId: idSchema,
  recordDate: dateSchema,
  mealType: z
    .enum(MEAL_TYPES, { error: '餐次类型无效' })
    .refine((mealType) => mealType !== 'supplement', '常用组合不能加入补剂记录'),
});

export const copyMealsInputSchema = z
  .object({
    sourceDate: dateSchema,
    targetDate: dateSchema,
    mealTypes: z
      .array(z.enum(MEAL_TYPES, { error: '餐次类型无效' }))
      .min(1, '请至少选择一个要复制的餐次')
      .max(MEAL_TYPES.length)
      .refine((types) => new Set(types).size === types.length, '复制餐次不能重复'),
    replaceExisting: z.boolean().optional(),
  })
  .refine((input) => input.sourceDate !== input.targetDate, {
    message: '来源日期和目标日期不能相同',
    path: ['targetDate'],
  });

export const historyQuerySchema = z
  .object({
    startDate: dateSchema.optional(),
    endDate: dateSchema.optional(),
    planId: idSchema.optional(),
    calorieStatus: z.enum(GOAL_FILTERS, { error: '热量目标筛选条件无效' }).optional(),
    proteinStatus: z.enum(GOAL_FILTERS, { error: '蛋白质目标筛选条件无效' }).optional(),
  })
  .refine((query) => !query.startDate || !query.endDate || query.endDate >= query.startDate, {
    message: '结束日期不能早于开始日期',
    path: ['endDate'],
  })
  .optional();

export const dateRangeQuerySchema = z
  .object({
    startDate: dateSchema.optional(),
    endDate: dateSchema.optional(),
  })
  .refine((query) => !query.startDate || !query.endDate || query.endDate >= query.startDate, {
    message: '结束日期不能早于开始日期',
    path: ['endDate'],
  });

export const exportCsvPayloadSchema = z.object({
  kind: z.enum(EXPORT_DATA_KINDS, { error: '导出数据类型无效' }),
  query: dateRangeQuerySchema.optional(),
});

export const importCsvKindSchema = z.enum(IMPORT_DATA_KINDS, { error: '导入数据类型无效' });

const safeSuggestedNameSchema = z
  .string()
  .trim()
  .min(1, '建议文件名不能为空')
  .max(120, '建议文件名不能超过 120 个字符')
  .regex(/^[^<>:"/\\|?*]+$/u, '建议文件名包含 Windows 不允许的字符')
  .refine(
    (name) =>
      [...name].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 0x1f && codePoint !== 0x7f;
      }),
    { message: '建议文件名包含控制字符' },
  )
  .refine((name) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name), {
    message: '建议文件名属于 Windows 保留名称',
  })
  .refine((name) => name !== '.' && name !== '..' && !/[. ]$/u.test(name), {
    message: '建议文件名不能以空格或句点结尾',
  });

export const chartImageExportInputSchema = z
  .object({
    format: z.enum(CHART_IMAGE_FORMATS, { error: '图片格式无效' }),
    suggestedName: safeSuggestedNameSchema,
    data: z
      .string()
      .min(1, '图片数据不能为空')
      .max(28 * 1024 * 1024, '图片数据过大'),
  })
  .superRefine((input, context) => {
    const validPrefix =
      input.format === 'png'
        ? input.data.startsWith('data:image/png;base64,')
        : /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/iu.test(input.data);
    if (!validPrefix) {
      context.addIssue({
        code: 'custom',
        path: ['data'],
        message: input.format === 'png' ? 'PNG 数据格式无效' : 'SVG 数据格式无效',
      });
    }
  });

const chartCsvCellSchema = z.union([
  z.string().max(CHART_CSV_LIMITS.maxStringCharacters, '图表 CSV 单元格内容过长'),
  z.number().finite('图表 CSV 数值必须为有限数'),
  z.null(),
]);

export const chartCsvExportInputSchema = z
  .object({
    suggestedName: safeSuggestedNameSchema,
    headers: z
      .array(
        z
          .string()
          .trim()
          .min(1, '图表 CSV 表头不能为空')
          .max(
            CHART_CSV_LIMITS.maxStringCharacters,
            `图表 CSV 表头不能超过 ${CHART_CSV_LIMITS.maxStringCharacters} 个字符`,
          ),
      )
      .min(1, '图表 CSV 至少需要一列')
      .max(CHART_CSV_LIMITS.maxColumns, `图表 CSV 最多允许 ${CHART_CSV_LIMITS.maxColumns} 列`)
      .refine((headers) => new Set(headers).size === headers.length, '图表 CSV 表头不能重复'),
    rows: z
      .array(z.array(chartCsvCellSchema).max(CHART_CSV_LIMITS.maxColumns))
      .max(CHART_CSV_LIMITS.maxRows),
  })
  .superRefine((input, context) => {
    input.rows.forEach((row, index) => {
      if (row.length !== input.headers.length) {
        context.addIssue({
          code: 'custom',
          path: ['rows', index],
          message: `图表 CSV 第 ${index + 2} 行列数与表头不一致`,
        });
      }
    });
  });
