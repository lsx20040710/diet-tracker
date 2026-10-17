export const CORE_MEAL_TYPES = ['breakfast', 'lunch', 'dinner'] as const;
export type CoreMealType = (typeof CORE_MEAL_TYPES)[number];

export const REGULAR_MEAL_TYPES = [...CORE_MEAL_TYPES, 'snack'] as const;
export type RegularMealType = (typeof REGULAR_MEAL_TYPES)[number];

export const MEAL_TYPES = [...REGULAR_MEAL_TYPES, 'supplement'] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const MEAL_AMOUNT_MODES = ['manual', 'recommended', 'indulgence'] as const;
export type MealAmountMode = (typeof MEAL_AMOUNT_MODES)[number];

export const UNIT_TYPES = ['gram', 'serving'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

/** 补剂计划只描述用户自行设定的提醒频率，不用于判断医学适用性。 */
export const SUPPLEMENT_FREQUENCIES = ['as_needed', 'daily', 'weekdays'] as const;
export type SupplementFrequency = (typeof SUPPLEMENT_FREQUENCIES)[number];

export const SUPPLEMENT_WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type SupplementWeekday = (typeof SUPPLEMENT_WEEKDAYS)[number];

export const FOOD_CATEGORIES = [
  '主食',
  '肉类',
  '蛋类',
  '奶制品',
  '蔬菜',
  '水果',
  '坚果',
  '调味品',
  '饮料',
  '零食',
  '补剂',
  '其他',
] as const;
export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

export const FOOD_SCOPES = ['all', 'recent', 'favorite'] as const;
export type FoodScope = (typeof FOOD_SCOPES)[number];

export const FOOD_KINDS = ['all', 'food', 'supplement'] as const;
export type FoodKind = (typeof FOOD_KINDS)[number];

export const GOAL_TYPES = ['减脂', '增肌', '维持体重', '自定义'] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const DIET_PLAN_CALCULATION_MODES = ['manual', 'weight_based'] as const;
export type DietPlanCalculationMode = (typeof DIET_PLAN_CALCULATION_MODES)[number];

/** 体重系数模式可跟随最新记录，也可固定为用户手动输入的体重。 */
export const DIET_PLAN_WEIGHT_SOURCE_MODES = ['latest', 'manual'] as const;
export type DietPlanWeightSourceMode = (typeof DIET_PLAN_WEIGHT_SOURCE_MODES)[number];

export interface NutritionValues {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export type NutritionTarget = NutritionValues;
export type NutritionMetric = keyof NutritionValues;

export const ENERGY_UNITS = ['kcal', 'kJ'] as const;
export type EnergyUnit = (typeof ENERGY_UNITS)[number];

export interface AppSettings {
  defaultEnergyUnit: EnergyUnit;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultEnergyUnit: 'kJ',
};

/** 同一饮食方案内，早中晚共同使用一组可自定义比例。 */
export interface MealRatios {
  breakfast: number;
  lunch: number;
  dinner: number;
}

export const DEFAULT_MEAL_RATIOS: MealRatios = {
  breakfast: 4,
  lunch: 3,
  dinner: 3,
};

/** 保存目标的计算来源，确保每个方案或日型都能独立还原体重系数。 */
export interface DietPlanCalculationSource {
  calculationMode: DietPlanCalculationMode;
  weightSourceMode: DietPlanWeightSourceMode;
  calculationWeight: number | null;
  weightSourceDate: string | null;
  proteinPerKg: number | null;
  carbsPerKg: number | null;
  fatPerKg: number | null;
}

export interface DietPlanCalculationInput {
  calculationMode?: DietPlanCalculationMode;
  weightSourceMode?: DietPlanWeightSourceMode;
  calculationWeight?: number | null;
  weightSourceDate?: string | null;
  proteinPerKg?: number | null;
  carbsPerKg?: number | null;
  fatPerKg?: number | null;
}

export interface NutritionProgress {
  consumed: NutritionValues;
  target: NutritionTarget;
  remaining: NutritionValues;
}

export interface BodyRecord {
  id: number;
  recordDate: string;
  weight: number | null;
  bodyFatPercentage: number | null;
  waistCircumference: number | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface BodyRecordInput {
  recordDate: string;
  weight?: number | null;
  bodyFatPercentage?: number | null;
  waistCircumference?: number | null;
  note?: string;
}

export interface Food {
  id: number;
  name: string;
  brand: string;
  category: FoodCategory;
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  defaultServingGrams: number | null;
  unitName: string;
  isSupplement: boolean;
  countInNutrition: boolean;
  isFavorite: boolean;
  isRecommendable: boolean;
  isArchived: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  supplementFrequency: SupplementFrequency;
  supplementWeekdays: SupplementWeekday[];
  supplementDosage: number | null;
  supplementDosageUnit: UnitType;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface FoodInput {
  name: string;
  brand?: string;
  category: FoodCategory;
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
  defaultServingGrams?: number | null;
  unitName?: string;
  isSupplement?: boolean;
  countInNutrition?: boolean;
  isFavorite?: boolean;
  isRecommendable?: boolean;
  supplementFrequency?: SupplementFrequency;
  supplementWeekdays?: SupplementWeekday[];
  supplementDosage?: number | null;
  supplementDosageUnit?: UnitType;
  note?: string;
}

export interface MealRecord extends NutritionValues {
  id: number;
  recordDate: string;
  mealType: MealType;
  foodId: number | null;
  foodNameSnapshot: string;
  brandSnapshot: string;
  categorySnapshot: FoodCategory;
  amount: number;
  unitType: UnitType;
  unitNameSnapshot: string;
  servingUnitNameSnapshot: string;
  defaultServingGramsSnapshot: number | null;
  gramsSnapshot: number;
  countInNutritionSnapshot: boolean;
  amountMode: MealAmountMode;
  recommendationMetric: NutritionMetric | null;
  sortOrder: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface MealRecordInput {
  recordDate: string;
  mealType: MealType;
  foodId: number;
  amount: number;
  unitType: UnitType;
  amountMode?: Exclude<MealAmountMode, 'indulgence'>;
  note?: string;
}

export interface MealRecordUpdate {
  id: number;
  amount: number;
  unitType: UnitType;
  note?: string;
}

export interface DietPlan extends NutritionTarget, DietPlanCalculationSource {
  id: number;
  name: string;
  goalType: GoalType;
  mealRatios: MealRatios;
  isActive: boolean;
  startDate: string;
  endDate: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface DietPlanInput extends DietPlanCalculationInput {
  name: string;
  goalType: GoalType;
  targetCalories: number;
  targetProtein: number;
  targetCarbs: number;
  targetFat: number;
  mealRatios?: MealRatios;
  startDate: string;
  endDate?: string | null;
  note?: string;
}

/** 同一饮食方案下可按日期切换的日型目标。 */
export interface DietPlanVariant extends NutritionTarget, DietPlanCalculationSource {
  id: number;
  planId: number;
  name: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface DietPlanVariantInput extends DietPlanCalculationInput {
  planId: number;
  name: string;
  targetCalories: number;
  targetProtein: number;
  targetCarbs: number;
  targetFat: number;
  note?: string;
}

/** 更新日型时不允许改变所属饮食方案。 */
export type DietPlanVariantUpdateInput = Omit<DietPlanVariantInput, 'planId'>;

export interface SetDailyPlanVariantInput {
  recordDate: string;
  variantId: number;
}

/** 保存每日目标及日型名称，避免日型后续修改影响历史。 */
export interface DailyPlanSnapshot {
  recordDate: string;
  planId: number | null;
  planName: string;
  variantId: number | null;
  variantName: string | null;
  target: NutritionTarget;
  mealRatios: MealRatios;
  createdAt: string;
  updatedAt: string;
}

export interface CoreMealAllocation {
  mealType: CoreMealType;
  baseTarget: NutritionTarget;
  target: NutritionTarget;
  consumed: NutritionValues;
  remaining: NutritionValues;
  overageToNext: NutritionValues;
  snackDeduction: NutritionValues;
  isIndulgence: boolean;
}

/** 当天三餐的动态额度；加餐没有独立配额，只记录其扣减去向。 */
export interface DailyMealAllocation {
  mealRatios: MealRatios;
  meals: Record<CoreMealType, CoreMealAllocation>;
  snack: {
    consumed: NutritionValues;
    deductedFrom: CoreMealType;
  };
}

export interface DashboardData {
  date: string;
  bodyRecord: BodyRecord | null;
  activePlan: DietPlan | null;
  dailyPlan: DailyPlanSnapshot | null;
  meals: Record<MealType, MealRecord[]>;
  mealAllocation: DailyMealAllocation;
  supplementRecommendations: Food[];
  nutrition: NutritionProgress;
}

export interface SetMealIndulgenceInput {
  recordDate: string;
  mealType: CoreMealType;
  enabled: boolean;
}

export interface FoodQuery {
  search?: string;
  category?: FoodCategory | '全部';
  scope?: FoodScope;
  kind?: FoodKind;
  includeArchived?: boolean;
  limit?: number;
}

export interface FoodCombinationItemInput {
  foodId: number;
  amount: number;
  unitType: UnitType;
}

export interface FoodCombinationInput {
  name: string;
  description?: string;
  items: FoodCombinationItemInput[];
}

export interface FoodCombinationItem extends FoodCombinationItemInput {
  id: number;
  combinationId: number;
  sortOrder: number;
  food: Food;
}

export interface FoodCombination {
  id: number;
  name: string;
  description: string;
  items: FoodCombinationItem[];
  createdAt: string;
  updatedAt: string;
}

export interface AddCombinationToMealInput {
  combinationId: number;
  recordDate: string;
  mealType: MealType;
}

export interface CopyMealsInput {
  sourceDate: string;
  targetDate: string;
  mealTypes: MealType[];
  replaceExisting?: boolean;
}

export interface CopyMealsResult {
  sourceDate: string;
  targetDate: string;
  copiedCount: number;
}

export const GOAL_FILTERS = ['all', 'met', 'not_met'] as const;
export type GoalFilter = (typeof GOAL_FILTERS)[number];

export interface HistoryQuery {
  startDate?: string;
  endDate?: string;
  planId?: number;
  calorieStatus?: GoalFilter;
  proteinStatus?: GoalFilter;
}

export interface HistoryDaySummary {
  recordDate: string;
  weight: number | null;
  bodyFatPercentage: number | null;
  waistCircumference: number | null;
  nutrition: NutritionValues;
  planId: number | null;
  planName: string | null;
  variantName: string | null;
  target: NutritionTarget | null;
  mealCount: number;
  meetsCalories: boolean | null;
  meetsProtein: boolean | null;
}

export interface HistoryDayDetail {
  summary: HistoryDaySummary;
  meals: Record<MealType, MealRecord[]>;
}

export interface DateRangeQuery {
  startDate?: string;
  endDate?: string;
}

export interface TrendDataPoint {
  recordDate: string;
  weight: number | null;
  bodyFatPercentage: number | null;
  waistCircumference: number | null;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  target: NutritionTarget | null;
}

export const EXPORT_DATA_KINDS = [
  'body_records',
  'meal_records',
  'nutrition_summaries',
  'foods',
  'diet_plans',
  'food_combinations',
] as const;
export type ExportDataKind = (typeof EXPORT_DATA_KINDS)[number];

export const IMPORT_DATA_KINDS = ['body_records', 'foods'] as const;
export type ImportDataKind = (typeof IMPORT_DATA_KINDS)[number];

export interface FileOperationResult {
  canceled: boolean;
  filePath: string | null;
  recordCount: number;
}

export interface ImportCsvResult extends FileOperationResult {
  createdCount: number;
  updatedCount: number;
}

export const CHART_IMAGE_FORMATS = ['png', 'svg'] as const;
export type ChartImageFormat = (typeof CHART_IMAGE_FORMATS)[number];

export interface ChartImageExportInput {
  format: ChartImageFormat;
  suggestedName: string;
  data: string;
}

export type ChartCsvCell = string | number | null;

/** 图表数据只包含日期和少量数值列，共享限制用于约束 IPC 与主进程内存占用。 */
export const CHART_CSV_LIMITS = {
  maxColumns: 8,
  maxRows: 10_000,
  maxStringCharacters: 128,
  maxBytes: 5 * 1024 * 1024,
} as const;

export interface ChartCsvExportInput {
  suggestedName: string;
  headers: string[];
  rows: ChartCsvCell[][];
}

export interface AppInfo {
  version: string;
  databasePath: string;
  databaseVersion: number;
}

export interface DataStorageMigrationNotice {
  status: 'completed' | 'cleanup_pending';
  sourceDirectory: string;
  sourceDatabasePath: string;
  message: string;
}

export interface DataStorageInfo {
  directory: string;
  databasePath: string;
  defaultDirectory: string;
  isDefault: boolean;
  migrationNotice?: DataStorageMigrationNotice | null;
}

export interface DataStorageSelection {
  selectionId: string;
  directory: string;
  databasePath: string;
  hasExistingDatabase: boolean;
  isCurrent: boolean;
}

export interface DataStorageChangeInput {
  selectionId: string;
  mode: 'migrate' | 'existing';
}

export interface DataStorageChangeResult {
  changed: boolean;
  storage: DataStorageInfo;
  previousDirectory: string | null;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface DietTrackerApi {
  getAppInfo(): Promise<ApiResult<AppInfo>>;
  getAppSettings(): Promise<ApiResult<AppSettings>>;
  saveAppSettings(settings: AppSettings): Promise<ApiResult<AppSettings>>;
  getStorageInfo(): Promise<ApiResult<DataStorageInfo>>;
  chooseStorageDirectory(): Promise<ApiResult<DataStorageSelection | null>>;
  changeStorageDirectory(
    input: DataStorageChangeInput,
  ): Promise<ApiResult<DataStorageChangeResult>>;
  getDashboard(date: string): Promise<ApiResult<DashboardData>>;
  listBodyRecords(): Promise<ApiResult<BodyRecord[]>>;
  upsertBodyRecord(input: BodyRecordInput): Promise<ApiResult<BodyRecord>>;
  deleteBodyRecord(id: number): Promise<ApiResult<void>>;
  listFoods(query?: FoodQuery): Promise<ApiResult<Food[]>>;
  createFood(input: FoodInput): Promise<ApiResult<Food>>;
  updateFood(id: number, input: FoodInput): Promise<ApiResult<Food>>;
  setFoodFavorite(id: number, isFavorite: boolean): Promise<ApiResult<Food>>;
  archiveFood(id: number): Promise<ApiResult<void>>;
  createMealRecord(input: MealRecordInput): Promise<ApiResult<MealRecord>>;
  updateMealRecord(input: MealRecordUpdate): Promise<ApiResult<MealRecord>>;
  deleteMealRecord(id: number): Promise<ApiResult<void>>;
  clearMeal(date: string, mealType: MealType): Promise<ApiResult<void>>;
  reorderMeal(recordIds: number[]): Promise<ApiResult<void>>;
  setMealIndulgence(input: SetMealIndulgenceInput): Promise<ApiResult<void>>;
  listDietPlans(): Promise<ApiResult<DietPlan[]>>;
  createDietPlan(input: DietPlanInput): Promise<ApiResult<DietPlan>>;
  updateDietPlan(id: number, input: DietPlanInput): Promise<ApiResult<DietPlan>>;
  duplicateDietPlan(id: number, input: DietPlanInput): Promise<ApiResult<DietPlan>>;
  activateDietPlan(id: number): Promise<ApiResult<DietPlan>>;
  deleteDietPlan(id: number): Promise<ApiResult<void>>;
  listDietPlanVariants(planId: number): Promise<ApiResult<DietPlanVariant[]>>;
  createDietPlanVariant(input: DietPlanVariantInput): Promise<ApiResult<DietPlanVariant>>;
  updateDietPlanVariant(
    id: number,
    input: DietPlanVariantUpdateInput,
  ): Promise<ApiResult<DietPlanVariant>>;
  deleteDietPlanVariant(id: number): Promise<ApiResult<void>>;
  setDailyPlanVariant(input: SetDailyPlanVariantInput): Promise<ApiResult<DailyPlanSnapshot>>;
  clearDailyPlanVariant(recordDate: string): Promise<ApiResult<DailyPlanSnapshot>>;
  listFoodCombinations(): Promise<ApiResult<FoodCombination[]>>;
  createFoodCombination(input: FoodCombinationInput): Promise<ApiResult<FoodCombination>>;
  updateFoodCombination(
    id: number,
    input: FoodCombinationInput,
  ): Promise<ApiResult<FoodCombination>>;
  deleteFoodCombination(id: number): Promise<ApiResult<void>>;
  addCombinationToMeal(input: AddCombinationToMealInput): Promise<ApiResult<MealRecord[]>>;
  copyMeals(input: CopyMealsInput): Promise<ApiResult<CopyMealsResult>>;
  listHistory(query?: HistoryQuery): Promise<ApiResult<HistoryDaySummary[]>>;
  getHistoryDay(date: string): Promise<ApiResult<HistoryDayDetail>>;
  getTrendData(query: DateRangeQuery): Promise<ApiResult<TrendDataPoint[]>>;
  exportExcel(query?: DateRangeQuery): Promise<ApiResult<FileOperationResult>>;
  exportCsv(kind: ExportDataKind, query?: DateRangeQuery): Promise<ApiResult<FileOperationResult>>;
  importCsv(kind: ImportDataKind): Promise<ApiResult<ImportCsvResult>>;
  exportChartCsv(input: ChartCsvExportInput): Promise<ApiResult<FileOperationResult>>;
  exportChartImage(input: ChartImageExportInput): Promise<ApiResult<FileOperationResult>>;
}
