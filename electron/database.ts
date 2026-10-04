import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { pinyin } from 'pinyin-pro';

import {
  CORE_MEAL_TYPES,
  DEFAULT_MEAL_RATIOS,
  DIET_PLAN_WEIGHT_SOURCE_MODES,
  GOAL_TYPES,
  SUPPLEMENT_FREQUENCIES,
  SUPPLEMENT_WEEKDAYS,
  type AddCombinationToMealInput,
  type AppInfo,
  type BodyRecord,
  type BodyRecordInput,
  type CopyMealsInput,
  type CopyMealsResult,
  type CoreMealType,
  type DashboardData,
  type DailyPlanSnapshot,
  type DateRangeQuery,
  type DietPlan,
  type DietPlanCalculationInput,
  type DietPlanCalculationMode,
  type DietPlanCalculationSource,
  type DietPlanInput,
  type DietPlanVariant,
  type DietPlanVariantInput,
  type DietPlanVariantUpdateInput,
  type DietPlanWeightSourceMode,
  type Food,
  type FoodCategory,
  type FoodCombination,
  type FoodCombinationInput,
  type FoodCombinationItem,
  type FoodInput,
  type FoodQuery,
  type HistoryDayDetail,
  type HistoryDaySummary,
  type HistoryQuery,
  type MealRecord,
  type MealRecordInput,
  type MealRecordUpdate,
  type MealRatios,
  type MealType,
  type NutritionMetric,
  type NutritionValues,
  type SetDailyPlanVariantInput,
  type SetMealIndulgenceInput,
  type SupplementFrequency,
  type SupplementWeekday,
  type TrendDataPoint,
  type UnitType,
} from '../src/types/models';
import {
  addNutrition,
  calculateAdjustedMealTarget,
  calculateCarryOver,
  calculateDailyMealAllocation,
  calculateRecommendedMealAmount,
  splitNutritionByMealRatios,
  subtractNutrition,
  zeroNutrition,
} from '../src/utils/meal-allocation';
import { isMealAmountValid, normalizeMealAmountValue } from '../src/utils/meal-amount';
import { calculateWeightBasedPlan } from '../src/utils/diet-plan';
import { AppError } from './errors';

type SqlRow = Record<string, unknown>;

interface Migration {
  version: number;
  name: string;
  apply(database: DatabaseSync): void;
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

/** CSV 食物导入在标准食物字段之外保留停用状态。 */
export interface ImportedFoodRecord {
  input: FoodInput;
  isArchived: boolean;
}

export interface DatabaseImportResult {
  createdCount: number;
  updatedCount: number;
}

const DATABASE_SCHEMA_VERSION = 10;
const ISO_TIMESTAMP_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const CREATE_SCHEMA_SQL = `
  CREATE TABLE body_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_date TEXT NOT NULL,
    weight REAL CHECK (weight IS NULL OR weight > 0),
    body_fat_percentage REAL CHECK (
      body_fat_percentage IS NULL OR
      (body_fat_percentage >= 0 AND body_fat_percentage <= 100)
    ),
    waist_circumference REAL CHECK (
      waist_circumference IS NULL OR waist_circumference > 0
    ),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE UNIQUE INDEX idx_body_records_record_date
    ON body_records(record_date);

  CREATE TABLE foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    brand TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    calories_per_100g REAL NOT NULL CHECK (calories_per_100g >= 0),
    protein_per_100g REAL NOT NULL CHECK (protein_per_100g >= 0),
    carbs_per_100g REAL NOT NULL CHECK (carbs_per_100g >= 0),
    fat_per_100g REAL NOT NULL CHECK (fat_per_100g >= 0),
    default_serving_grams REAL CHECK (
      default_serving_grams IS NULL OR default_serving_grams > 0
    ),
    unit_name TEXT NOT NULL DEFAULT '份',
    is_supplement INTEGER NOT NULL DEFAULT 0 CHECK (is_supplement IN (0, 1)),
    count_in_nutrition INTEGER NOT NULL DEFAULT 1 CHECK (count_in_nutrition IN (0, 1)),
    is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    is_recommendable INTEGER NOT NULL DEFAULT 1 CHECK (is_recommendable IN (0, 1)),
    is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
    usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
    last_used_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX idx_foods_name ON foods(name COLLATE NOCASE);
  CREATE INDEX idx_foods_category_archived ON foods(category, is_archived);
  CREATE INDEX idx_foods_last_used_at ON foods(last_used_at DESC);

  CREATE TABLE diet_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    goal_type TEXT NOT NULL,
    target_calories REAL NOT NULL CHECK (target_calories >= 0),
    target_protein REAL NOT NULL CHECK (target_protein >= 0),
    target_carbs REAL NOT NULL CHECK (target_carbs >= 0),
    target_fat REAL NOT NULL CHECK (target_fat >= 0),
    is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    start_date TEXT NOT NULL,
    end_date TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_date IS NULL OR end_date >= start_date)
  ) STRICT;

  CREATE UNIQUE INDEX idx_diet_plans_active
    ON diet_plans(is_active) WHERE is_active = 1;
  CREATE INDEX idx_diet_plans_dates ON diet_plans(start_date, end_date);

  CREATE TABLE meal_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_date TEXT NOT NULL,
    meal_type TEXT NOT NULL CHECK (
      meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')
    ),
    food_id INTEGER REFERENCES foods(id) ON DELETE SET NULL,
    food_name_snapshot TEXT NOT NULL,
    brand_snapshot TEXT NOT NULL DEFAULT '',
    category_snapshot TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    unit_type TEXT NOT NULL CHECK (unit_type IN ('gram', 'serving')),
    unit_name_snapshot TEXT NOT NULL,
    serving_unit_name_snapshot TEXT NOT NULL,
    grams_snapshot REAL NOT NULL CHECK (grams_snapshot > 0),
    default_serving_grams_snapshot REAL,
    calories_per_100g_snapshot REAL NOT NULL CHECK (calories_per_100g_snapshot >= 0),
    protein_per_100g_snapshot REAL NOT NULL CHECK (protein_per_100g_snapshot >= 0),
    carbs_per_100g_snapshot REAL NOT NULL CHECK (carbs_per_100g_snapshot >= 0),
    fat_per_100g_snapshot REAL NOT NULL CHECK (fat_per_100g_snapshot >= 0),
    calories_snapshot REAL NOT NULL CHECK (calories_snapshot >= 0),
    protein_snapshot REAL NOT NULL CHECK (protein_snapshot >= 0),
    carbs_snapshot REAL NOT NULL CHECK (carbs_snapshot >= 0),
    fat_snapshot REAL NOT NULL CHECK (fat_snapshot >= 0),
    count_in_nutrition_snapshot INTEGER NOT NULL CHECK (
      count_in_nutrition_snapshot IN (0, 1)
    ),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX idx_meal_records_date ON meal_records(record_date);
  CREATE INDEX idx_meal_records_date_type_order
    ON meal_records(record_date, meal_type, sort_order, id);
  CREATE INDEX idx_meal_records_food_id ON meal_records(food_id);

  CREATE TABLE food_combinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE food_combination_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    combination_id INTEGER NOT NULL REFERENCES food_combinations(id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES foods(id) ON DELETE RESTRICT,
    amount REAL NOT NULL CHECK (amount > 0),
    unit_type TEXT NOT NULL CHECK (unit_type IN ('gram', 'serving')),
    sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0)
  ) STRICT;

  CREATE INDEX idx_food_combination_items_combination
    ON food_combination_items(combination_id, sort_order, id);

  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
`;

interface SeedFood {
  name: string;
  category: FoodCategory;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  servingGrams: number | null;
  unitName: string;
  isSupplement?: boolean;
  countInNutrition?: boolean;
}

interface DefaultSupplement {
  name: string;
  unitName: string;
  countInNutrition: boolean;
  note: string;
  legacyDefaults?: Omit<SeedFood, 'name' | 'category' | 'isSupplement'>;
}

const BUILT_IN_FOODS: SeedFood[] = [
  {
    name: '米饭（熟）',
    category: '主食',
    calories: 116,
    protein: 2.6,
    carbs: 25.9,
    fat: 0.3,
    servingGrams: 150,
    unitName: '碗',
  },
  {
    name: '燕麦片',
    category: '主食',
    calories: 338,
    protein: 10.1,
    carbs: 77.4,
    fat: 0.2,
    servingGrams: 50,
    unitName: '份',
  },
  {
    name: '红薯（熟）',
    category: '主食',
    calories: 86,
    protein: 1.6,
    carbs: 20.1,
    fat: 0.1,
    servingGrams: 150,
    unitName: '个',
  },
  {
    name: '鸡胸肉（熟）',
    category: '肉类',
    calories: 165,
    protein: 31,
    carbs: 0,
    fat: 3.6,
    servingGrams: 100,
    unitName: '份',
  },
  {
    name: '瘦牛肉（熟）',
    category: '肉类',
    calories: 250,
    protein: 26,
    carbs: 0,
    fat: 15,
    servingGrams: 100,
    unitName: '份',
  },
  {
    name: '鸡蛋',
    category: '蛋类',
    calories: 144,
    protein: 13.3,
    carbs: 2.8,
    fat: 8.8,
    servingGrams: 50,
    unitName: '个',
  },
  {
    name: '全脂牛奶',
    category: '奶制品',
    calories: 61,
    protein: 3.2,
    carbs: 4.8,
    fat: 3.3,
    servingGrams: 250,
    unitName: '杯',
  },
  {
    name: '西兰花',
    category: '蔬菜',
    calories: 34,
    protein: 2.8,
    carbs: 6.6,
    fat: 0.4,
    servingGrams: 200,
    unitName: '份',
  },
  {
    name: '番茄',
    category: '蔬菜',
    calories: 18,
    protein: 0.9,
    carbs: 3.9,
    fat: 0.2,
    servingGrams: 150,
    unitName: '个',
  },
  {
    name: '苹果',
    category: '水果',
    calories: 52,
    protein: 0.3,
    carbs: 13.8,
    fat: 0.2,
    servingGrams: 180,
    unitName: '个',
  },
  {
    name: '香蕉',
    category: '水果',
    calories: 89,
    protein: 1.1,
    carbs: 22.8,
    fat: 0.3,
    servingGrams: 120,
    unitName: '根',
  },
  {
    name: '杏仁',
    category: '坚果',
    calories: 579,
    protein: 21.2,
    carbs: 21.6,
    fat: 49.9,
    servingGrams: 20,
    unitName: '份',
  },
  {
    name: '橄榄油',
    category: '调味品',
    calories: 899,
    protein: 0,
    carbs: 0,
    fat: 99.9,
    servingGrams: 10,
    unitName: '勺',
  },
  {
    name: '鱼油',
    category: '补剂',
    calories: 1000,
    protein: 0,
    carbs: 0,
    fat: 100,
    servingGrams: 1,
    unitName: '粒',
    isSupplement: true,
    countInNutrition: true,
  },
  {
    name: '肌酸',
    category: '补剂',
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    servingGrams: 5,
    unitName: '份',
    isSupplement: true,
    countInNutrition: false,
  },
  {
    name: '复合维生素',
    category: '补剂',
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    servingGrams: 1,
    unitName: '片',
    isSupplement: true,
    countInNutrition: false,
  },
];

const LEGACY_BUILT_IN_NOTE = '内置参考值，可按食品标签修改。';

/**
 * 默认补剂只提供名称、单位和谨慎的作用说明。
 * 营养和每份重量取决于实际产品，因此新数据库中不写入伪参考值。
 */
const DEFAULT_SUPPLEMENTS: DefaultSupplement[] = [
  {
    name: '肌酸',
    unitName: '份',
    countInNutrition: false,
    note: '帮助肌肉为短时高强度活动供能，部分人可改善力量或功率；请按实际产品标签填写用量与营养。',
    legacyDefaults: {
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      servingGrams: 5,
      unitName: '份',
    },
  },
  {
    name: '电解质冲粉',
    unitName: '份',
    countInNutrition: false,
    note: '用于补充产品所含电解质；不同产品的成分和用量差异较大，请按实际标签填写。',
  },
  {
    name: '蛋白粉',
    unitName: '份',
    countInNutrition: true,
    note: '方便补充蛋白质，支持肌肉的构建、维持与修复；碳水、蛋白质、脂肪和热量请按实际产品标签填写。',
  },
  {
    name: '锌镁片',
    unitName: '片',
    countInNutrition: false,
    note: '用于补充锌和镁，参与多种正常生理过程；请按实际产品标签使用，避免与其他产品重复过量。',
  },
  {
    name: '复合维生素',
    unitName: '片',
    countInNutrition: false,
    note: '用于补充多种维生素和矿物质；请按实际产品标签填写用量，不能代替均衡饮食。',
    legacyDefaults: {
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      servingGrams: 1,
      unitName: '片',
    },
  },
  {
    name: '鱼油',
    unitName: '粒',
    countInNutrition: true,
    note: '提供 EPA、DHA 等 Omega-3 脂肪酸；每粒脂肪和热量因产品而异，请按实际产品标签填写。',
    legacyDefaults: {
      calories: 1000,
      protein: 0,
      carbs: 0,
      fat: 100,
      servingGrams: 1,
      unitName: '粒',
    },
  },
  {
    name: '谷氨酰胺',
    unitName: '份',
    countInNutrition: false,
    note: '参与代谢等生理过程；单独补充改善运动表现的证据不足，请按实际产品标签填写。',
  },
];

/** 只有完整匹配旧版内置指纹时，才能安全清理伪参考营养。 */
function hasLegacySupplementDefaults(row: SqlRow, supplement: DefaultSupplement): boolean {
  const legacy = supplement.legacyDefaults;
  if (!legacy) {
    return false;
  }
  const servingGrams =
    row.default_serving_grams === null || row.default_serving_grams === undefined
      ? null
      : Number(row.default_serving_grams);
  return (
    String(row.brand) === '' &&
    String(row.note) === LEGACY_BUILT_IN_NOTE &&
    String(row.category) === '补剂' &&
    Number(row.is_supplement) === 1 &&
    Number(row.calories_per_100g) === legacy.calories &&
    Number(row.protein_per_100g) === legacy.protein &&
    Number(row.carbs_per_100g) === legacy.carbs &&
    Number(row.fat_per_100g) === legacy.fat &&
    servingGrams === legacy.servingGrams &&
    String(row.unit_name) === legacy.unitName
  );
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_initial_schema',
    apply(database) {
      database.exec(CREATE_SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: 'seed_builtin_foods_and_default_plan',
    apply(database) {
      const insertFood = database.prepare(`
        INSERT INTO foods (
          name, brand, category, calories_per_100g, protein_per_100g,
          carbs_per_100g, fat_per_100g, default_serving_grams, unit_name,
          is_supplement, count_in_nutrition, is_favorite, is_recommendable,
          is_archived, usage_count, note, created_at, updated_at
        ) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 0,
          '内置参考值，可按食品标签修改。',
          ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
      `);
      const findFood = database.prepare(
        "SELECT 1 FROM foods WHERE name = ? COLLATE NOCASE AND brand = '' LIMIT 1",
      );

      for (const food of BUILT_IN_FOODS) {
        if (findFood.get(food.name)) {
          continue;
        }
        insertFood.run(
          food.name,
          food.category,
          food.calories,
          food.protein,
          food.carbs,
          food.fat,
          food.servingGrams,
          food.unitName,
          food.isSupplement ? 1 : 0,
          food.countInNutrition === false ? 0 : 1,
          food.isSupplement ? 0 : 1,
        );
      }

      const planCount = database.prepare('SELECT COUNT(*) AS count FROM diet_plans').get() as {
        count: number;
      };
      if (Number(planCount.count) === 0) {
        database
          .prepare(
            `
          INSERT INTO diet_plans (
            name, goal_type, target_calories, target_protein, target_carbs,
            target_fat, is_active, start_date, end_date, note, created_at, updated_at
          ) VALUES (
            '均衡饮食方案', '维持体重', 2000, 120, 230, 67, 1,
            date('now', 'localtime'), NULL, '首次启动自动创建，可按实际情况修改。',
            ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL}
          )
          `,
          )
          .run();
      }
    },
  },
  {
    version: 3,
    name: 'add_food_search_and_daily_plan_snapshots',
    apply(database) {
      database.exec(`
        ALTER TABLE foods
          ADD COLUMN pinyin_initials TEXT NOT NULL DEFAULT '';

        CREATE INDEX idx_foods_pinyin_initials
          ON foods(pinyin_initials COLLATE NOCASE);

        CREATE TABLE daily_plan_snapshots (
          record_date TEXT PRIMARY KEY,
          plan_id INTEGER,
          plan_name TEXT NOT NULL CHECK (length(trim(plan_name)) > 0),
          target_calories REAL NOT NULL CHECK (target_calories >= 0),
          target_protein REAL NOT NULL CHECK (target_protein >= 0),
          target_carbs REAL NOT NULL CHECK (target_carbs >= 0),
          target_fat REAL NOT NULL CHECK (target_fat >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX idx_daily_plan_snapshots_plan_date
          ON daily_plan_snapshots(plan_id, record_date DESC);
      `);

      // 拼音属于派生搜索字段，升级时一次性从真实食物名称重新生成。
      const foodRows = database.prepare('SELECT id, name FROM foods').all() as SqlRow[];
      const updatePinyin = database.prepare('UPDATE foods SET pinyin_initials = ? WHERE id = ?');
      for (const row of foodRows) {
        updatePinyin.run(createPinyinInitials(String(row.name)), toNumber(row.id));
      }

      // 旧版本没有每日方案概念，只能用升级时的活动方案安全补齐已有记录日期。
      database.exec(`
        INSERT OR IGNORE INTO daily_plan_snapshots (
          record_date, plan_id, plan_name, target_calories, target_protein,
          target_carbs, target_fat, created_at, updated_at
        )
        SELECT
          dates.record_date, active_plan.id, active_plan.name,
          active_plan.target_calories, active_plan.target_protein,
          active_plan.target_carbs, active_plan.target_fat,
          ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL}
        FROM (
          SELECT record_date FROM body_records
          UNION
          SELECT record_date FROM meal_records
        ) AS dates
        CROSS JOIN (
          SELECT * FROM diet_plans WHERE is_active = 1 LIMIT 1
        ) AS active_plan;
      `);
    },
  },
  {
    version: 4,
    name: 'add_weight_based_diet_plan_fields',
    apply(database) {
      // 旧方案继续按手动目标解释，升级不会改写既有热量和营养素目标。
      database.exec(`
        ALTER TABLE diet_plans
          ADD COLUMN calculation_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (calculation_mode IN ('manual', 'weight_based'));
        ALTER TABLE diet_plans ADD COLUMN calculation_weight REAL
          CHECK (
            calculation_weight IS NULL OR
            (calculation_weight > 0 AND calculation_weight <= 1000)
          );
        ALTER TABLE diet_plans ADD COLUMN weight_source_date TEXT;
        ALTER TABLE diet_plans ADD COLUMN protein_per_kg REAL
          CHECK (protein_per_kg IS NULL OR protein_per_kg BETWEEN 0 AND 20);
        ALTER TABLE diet_plans ADD COLUMN carbs_per_kg REAL
          CHECK (carbs_per_kg IS NULL OR carbs_per_kg BETWEEN 0 AND 20);
        ALTER TABLE diet_plans ADD COLUMN fat_per_kg REAL
          CHECK (fat_per_kg IS NULL OR fat_per_kg BETWEEN 0 AND 20);
      `);
    },
  },
  {
    version: 5,
    name: 'seed_default_supplements',
    apply(database) {
      const findByName = database.prepare(
        'SELECT * FROM foods WHERE name = ? COLLATE NOCASE ORDER BY id',
      );
      const insertSupplement = database.prepare(`
        INSERT INTO foods (
          name, pinyin_initials, brand, category, calories_per_100g, protein_per_100g,
          carbs_per_100g, fat_per_100g, default_serving_grams, unit_name,
          is_supplement, count_in_nutrition, is_favorite, is_recommendable,
          is_archived, usage_count, last_used_at, note, created_at, updated_at
        ) VALUES (?, ?, '', '补剂', 0, 0, 0, 0, NULL, ?, 1, ?, 0, 0, 0, 0, NULL, ?,
          ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
      `);
      const resetLegacySupplement = database.prepare(`
        UPDATE foods SET
          category = '补剂', calories_per_100g = 0, protein_per_100g = 0,
          carbs_per_100g = 0, fat_per_100g = 0, default_serving_grams = NULL,
          unit_name = ?, is_supplement = 1, is_recommendable = 0,
          note = ?, updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE id = ?
      `);
      const normalizeNamedSupplement = database.prepare(`
        UPDATE foods SET
          category = '补剂', is_supplement = 1, is_recommendable = 0,
          updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE id = ?
      `);

      for (const supplement of DEFAULT_SUPPLEMENTS) {
        const existingRows = findByName.all(supplement.name) as SqlRow[];
        if (existingRows.length === 0) {
          insertSupplement.run(
            supplement.name,
            createPinyinInitials(supplement.name),
            supplement.unitName,
            supplement.countInNutrition ? 1 : 0,
            supplement.note,
          );
          continue;
        }
        for (const row of existingRows) {
          if (hasLegacySupplementDefaults(row, supplement)) {
            resetLegacySupplement.run(supplement.unitName, supplement.note, Number(row.id));
          } else {
            // 同名用户条目只归入补剂库，不改写个性化营养和说明。
            normalizeNamedSupplement.run(Number(row.id));
          }
        }
      }

      // 补剂标记和旧“补剂”分类都应进入补剂库，其他用户字段保持不变。
      database.exec(`
        UPDATE foods SET
          category = '补剂',
          is_supplement = 1,
          updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE is_supplement = 1 OR category = '补剂';

        CREATE INDEX IF NOT EXISTS idx_foods_supplement_archived
          ON foods(is_supplement, is_archived);
      `);
    },
  },
  {
    version: 6,
    name: 'add_diet_plan_variants',
    apply(database) {
      database.exec(`
        CREATE TABLE diet_plan_variants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id INTEGER NOT NULL REFERENCES diet_plans(id) ON DELETE CASCADE,
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          target_calories REAL NOT NULL CHECK (target_calories >= 0),
          target_protein REAL NOT NULL CHECK (target_protein >= 0),
          target_carbs REAL NOT NULL CHECK (target_carbs >= 0),
          target_fat REAL NOT NULL CHECK (target_fat >= 0),
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE UNIQUE INDEX idx_diet_plan_variants_plan_name
          ON diet_plan_variants(plan_id, name COLLATE NOCASE);
        CREATE INDEX idx_diet_plan_variants_plan_updated
          ON diet_plan_variants(plan_id, updated_at DESC, id DESC);

        ALTER TABLE daily_plan_snapshots
          ADD COLUMN variant_id INTEGER
          REFERENCES diet_plan_variants(id) ON DELETE SET NULL;
        ALTER TABLE daily_plan_snapshots
          ADD COLUMN variant_name TEXT
          CHECK (variant_name IS NULL OR length(trim(variant_name)) > 0);

        CREATE INDEX idx_daily_plan_snapshots_variant_date
          ON daily_plan_snapshots(variant_id, record_date DESC);
      `);
    },
  },
  {
    version: 7,
    name: 'add_supplement_schedules_and_record_section',
    apply(database) {
      database.exec(`
        ALTER TABLE foods ADD COLUMN supplement_frequency TEXT NOT NULL DEFAULT 'as_needed'
          CHECK (supplement_frequency IN ('as_needed', 'daily', 'weekdays'));
        ALTER TABLE foods ADD COLUMN supplement_weekdays INTEGER NOT NULL DEFAULT 0
          CHECK (supplement_weekdays BETWEEN 0 AND 127);
        ALTER TABLE foods ADD COLUMN supplement_dosage REAL
          CHECK (supplement_dosage IS NULL OR supplement_dosage > 0);
        ALTER TABLE foods ADD COLUMN supplement_dosage_unit TEXT NOT NULL DEFAULT 'gram'
          CHECK (supplement_dosage_unit IN ('gram', 'serving'));

        CREATE INDEX idx_foods_supplement_schedule
          ON foods(is_supplement, is_archived, supplement_frequency);

        CREATE TEMP TABLE meal_records_v7_sequence (seq INTEGER NOT NULL) STRICT;
        INSERT INTO meal_records_v7_sequence (seq)
        SELECT COALESCE(
          (SELECT seq FROM sqlite_sequence WHERE name = 'meal_records'),
          0
        );

        CREATE TABLE meal_records_v7 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_date TEXT NOT NULL,
          meal_type TEXT NOT NULL CHECK (
            meal_type IN ('breakfast', 'lunch', 'dinner', 'snack', 'supplement')
          ),
          food_id INTEGER REFERENCES foods(id) ON DELETE SET NULL,
          food_name_snapshot TEXT NOT NULL,
          brand_snapshot TEXT NOT NULL DEFAULT '',
          category_snapshot TEXT NOT NULL,
          amount REAL NOT NULL CHECK (amount > 0),
          unit_type TEXT NOT NULL CHECK (unit_type IN ('gram', 'serving')),
          unit_name_snapshot TEXT NOT NULL,
          serving_unit_name_snapshot TEXT NOT NULL,
          grams_snapshot REAL NOT NULL CHECK (grams_snapshot > 0),
          default_serving_grams_snapshot REAL,
          calories_per_100g_snapshot REAL NOT NULL CHECK (calories_per_100g_snapshot >= 0),
          protein_per_100g_snapshot REAL NOT NULL CHECK (protein_per_100g_snapshot >= 0),
          carbs_per_100g_snapshot REAL NOT NULL CHECK (carbs_per_100g_snapshot >= 0),
          fat_per_100g_snapshot REAL NOT NULL CHECK (fat_per_100g_snapshot >= 0),
          calories_snapshot REAL NOT NULL CHECK (calories_snapshot >= 0),
          protein_snapshot REAL NOT NULL CHECK (protein_snapshot >= 0),
          carbs_snapshot REAL NOT NULL CHECK (carbs_snapshot >= 0),
          fat_snapshot REAL NOT NULL CHECK (fat_snapshot >= 0),
          count_in_nutrition_snapshot INTEGER NOT NULL CHECK (
            count_in_nutrition_snapshot IN (0, 1)
          ),
          sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO meal_records_v7 (
          id, record_date, meal_type, food_id, food_name_snapshot, brand_snapshot,
          category_snapshot, amount, unit_type, unit_name_snapshot,
          serving_unit_name_snapshot, grams_snapshot, default_serving_grams_snapshot,
          calories_per_100g_snapshot, protein_per_100g_snapshot,
          carbs_per_100g_snapshot, fat_per_100g_snapshot, calories_snapshot,
          protein_snapshot, carbs_snapshot, fat_snapshot, count_in_nutrition_snapshot,
          sort_order, note, created_at, updated_at
        )
        SELECT
          id, record_date, meal_type, food_id, food_name_snapshot, brand_snapshot,
          category_snapshot, amount, unit_type, unit_name_snapshot,
          serving_unit_name_snapshot, grams_snapshot, default_serving_grams_snapshot,
          calories_per_100g_snapshot, protein_per_100g_snapshot,
          carbs_per_100g_snapshot, fat_per_100g_snapshot, calories_snapshot,
          protein_snapshot, carbs_snapshot, fat_snapshot, count_in_nutrition_snapshot,
          sort_order, note, created_at, updated_at
        FROM meal_records;

        -- SQLite 不能直接修改 CHECK；事务内重建可保留全部历史快照和原始 ID。
        DROP TABLE meal_records;
        ALTER TABLE meal_records_v7 RENAME TO meal_records;

        CREATE INDEX idx_meal_records_date ON meal_records(record_date);
        CREATE INDEX idx_meal_records_date_type_order
          ON meal_records(record_date, meal_type, sort_order, id);
        CREATE INDEX idx_meal_records_food_id ON meal_records(food_id);

        INSERT INTO sqlite_sequence (name, seq)
        SELECT 'meal_records', seq FROM meal_records_v7_sequence
        WHERE seq > 0
          AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'meal_records');
        UPDATE sqlite_sequence
        SET seq = MAX(
          COALESCE(seq, 0),
          (SELECT seq FROM meal_records_v7_sequence)
        )
        WHERE name = 'meal_records';
        DROP TABLE meal_records_v7_sequence;
      `);
    },
  },
  {
    version: 8,
    name: 'add_weight_based_diet_plan_variant_fields',
    apply(database) {
      // 旧日型缺少可还原的系数来源，升级后按手动目标保留原有克数和热量。
      database.exec(`
        ALTER TABLE diet_plan_variants
          ADD COLUMN calculation_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (calculation_mode IN ('manual', 'weight_based'));
        ALTER TABLE diet_plan_variants ADD COLUMN calculation_weight REAL
          CHECK (
            calculation_weight IS NULL OR
            (calculation_weight > 0 AND calculation_weight <= 1000)
          );
        ALTER TABLE diet_plan_variants ADD COLUMN weight_source_date TEXT;
        ALTER TABLE diet_plan_variants ADD COLUMN protein_per_kg REAL
          CHECK (protein_per_kg IS NULL OR protein_per_kg BETWEEN 0 AND 20);
        ALTER TABLE diet_plan_variants ADD COLUMN carbs_per_kg REAL
          CHECK (carbs_per_kg IS NULL OR carbs_per_kg BETWEEN 0 AND 20);
        ALTER TABLE diet_plan_variants ADD COLUMN fat_per_kg REAL
          CHECK (fat_per_kg IS NULL OR fat_per_kg BETWEEN 0 AND 20);
      `);
    },
  },
  {
    version: 9,
    name: 'add_meal_allocations_recommendations_and_indulgence',
    apply(database) {
      database.exec(`
        ALTER TABLE diet_plans ADD COLUMN breakfast_ratio REAL NOT NULL DEFAULT 4
          CHECK (breakfast_ratio >= 0 AND breakfast_ratio <= 1000);
        ALTER TABLE diet_plans ADD COLUMN lunch_ratio REAL NOT NULL DEFAULT 3
          CHECK (lunch_ratio >= 0 AND lunch_ratio <= 1000);
        ALTER TABLE diet_plans ADD COLUMN dinner_ratio REAL NOT NULL DEFAULT 3
          CHECK (dinner_ratio >= 0 AND dinner_ratio <= 1000);

        ALTER TABLE daily_plan_snapshots ADD COLUMN breakfast_ratio REAL NOT NULL DEFAULT 4
          CHECK (breakfast_ratio >= 0 AND breakfast_ratio <= 1000);
        ALTER TABLE daily_plan_snapshots ADD COLUMN lunch_ratio REAL NOT NULL DEFAULT 3
          CHECK (lunch_ratio >= 0 AND lunch_ratio <= 1000);
        ALTER TABLE daily_plan_snapshots ADD COLUMN dinner_ratio REAL NOT NULL DEFAULT 3
          CHECK (dinner_ratio >= 0 AND dinner_ratio <= 1000);

        ALTER TABLE meal_records ADD COLUMN amount_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (amount_mode IN ('manual', 'recommended', 'indulgence'));
        ALTER TABLE meal_records ADD COLUMN recommendation_metric TEXT
          CHECK (
            recommendation_metric IS NULL OR
            recommendation_metric IN ('calories', 'protein', 'carbs', 'fat')
          );

        CREATE UNIQUE INDEX idx_meal_records_indulgence
          ON meal_records(record_date, meal_type)
          WHERE amount_mode = 'indulgence';

        CREATE TABLE daily_meal_settings (
          record_date TEXT PRIMARY KEY,
          snack_deduction_meal_type TEXT NOT NULL CHECK (
            snack_deduction_meal_type IN ('breakfast', 'lunch', 'dinner')
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 10,
    name: 'add_weight_source_mode',
    apply(database) {
      // 已有按体重系数方案改为默认跟随最新体重，历史每日快照保持原样。
      if (!hasTableColumn(database, 'diet_plans', 'weight_source_mode')) {
        database.exec(
          "ALTER TABLE diet_plans ADD COLUMN weight_source_mode TEXT NOT NULL DEFAULT 'latest' CHECK (weight_source_mode IN ('latest', 'manual'));",
        );
      }
      if (!hasTableColumn(database, 'diet_plan_variants', 'weight_source_mode')) {
        database.exec(
          "ALTER TABLE diet_plan_variants ADD COLUMN weight_source_mode TEXT NOT NULL DEFAULT 'latest' CHECK (weight_source_mode IN ('latest', 'manual'));",
        );
      }
      // 手动设置宏量目标不依赖体重记录，避免导出和后续编辑误显示为自动来源。
      if (hasTableColumn(database, 'diet_plans', 'calculation_mode')) {
        database.exec(
          "UPDATE diet_plans SET weight_source_mode = 'manual' WHERE calculation_mode = 'manual';",
        );
      }
      if (hasTableColumn(database, 'diet_plan_variants', 'calculation_mode')) {
        database.exec(
          "UPDATE diet_plan_variants SET weight_source_mode = 'manual' WHERE calculation_mode = 'manual';",
        );
      }
    },
  },
];

function createPinyinInitials(name: string): string {
  return (
    pinyin(name, {
      pattern: 'first',
      toneType: 'none',
      type: 'array',
      nonZh: 'consecutive',
    })
      .join('')
      // 标点不是首字母的一部分，否则“鸡胸肉（熟）”无法用 jxrs 搜索。
      .replace(/[^\p{L}\p{N}]/gu, '')
      .toLocaleLowerCase('zh-CN')
  );
}

function toBoolean(value: unknown): boolean {
  return Number(value) === 1;
}

function toNumber(value: unknown): number {
  return Number(value);
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function hasTableColumn(
  database: DatabaseSync,
  tableName: 'diet_plans' | 'diet_plan_variants',
  columnName: string,
): boolean {
  const columns = database.prepare('PRAGMA table_info(' + tableName + ')').all() as SqlRow[];
  return columns.some((column) => String(column.name) === columnName);
}

function hasWeightCalculationColumns(
  database: DatabaseSync,
  tableName: 'diet_plans' | 'diet_plan_variants',
): boolean {
  return [
    'calculation_mode',
    'calculation_weight',
    'weight_source_date',
    'protein_per_kg',
    'carbs_per_kg',
    'fat_per_kg',
    'weight_source_mode',
  ].every((columnName) => hasTableColumn(database, tableName, columnName));
}

function encodeSupplementWeekdays(weekdays: readonly SupplementWeekday[]): number {
  return weekdays.reduce((mask, weekday) => {
    const index = SUPPLEMENT_WEEKDAYS.indexOf(weekday);
    return index < 0 ? mask : mask | (1 << index);
  }, 0);
}

function decodeSupplementWeekdays(value: unknown): SupplementWeekday[] {
  const mask = toNumber(value);
  return SUPPLEMENT_WEEKDAYS.filter((_, index) => (mask & (1 << index)) !== 0);
}

function supplementWeekdayForDate(date: string): SupplementWeekday {
  const sundayBasedDay = new Date(`${date}T00:00:00Z`).getUTCDay();
  return SUPPLEMENT_WEEKDAYS[(sundayBasedDay + 6) % 7];
}

function roundFour(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

/** 在数据库写入前统一重量精度；份数允许小数，不受份量单位名称限制。 */
function normalizeStoredMealAmount(amount: number, unitType: UnitType): number {
  const normalizedAmount = normalizeMealAmountValue(amount, unitType);
  if (isMealAmountValid(normalizedAmount)) return normalizedAmount;
  throw new AppError(
    'VALIDATION_ERROR',
    unitType === 'gram'
      ? '按重量记录时数量必须是大于或等于 0.1 的数字。'
      : '按份记录时数量必须是大于或等于 0.1 的数字。',
  );
}

function mapBodyRecord(row: SqlRow): BodyRecord {
  return {
    id: toNumber(row.id),
    recordDate: String(row.record_date),
    weight: toNullableNumber(row.weight),
    bodyFatPercentage: toNullableNumber(row.body_fat_percentage),
    waistCircumference: toNullableNumber(row.waist_circumference),
    note: String(row.note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapFood(row: SqlRow): Food {
  return {
    id: toNumber(row.id),
    name: String(row.name),
    brand: String(row.brand),
    category: String(row.category) as FoodCategory,
    caloriesPer100g: toNumber(row.calories_per_100g),
    proteinPer100g: toNumber(row.protein_per_100g),
    carbsPer100g: toNumber(row.carbs_per_100g),
    fatPer100g: toNumber(row.fat_per_100g),
    defaultServingGrams: toNullableNumber(row.default_serving_grams),
    unitName: String(row.unit_name),
    isSupplement: toBoolean(row.is_supplement),
    countInNutrition: toBoolean(row.count_in_nutrition),
    isFavorite: toBoolean(row.is_favorite),
    isRecommendable: toBoolean(row.is_recommendable),
    isArchived: toBoolean(row.is_archived),
    usageCount: toNumber(row.usage_count),
    lastUsedAt: toNullableString(row.last_used_at),
    supplementFrequency: String(row.supplement_frequency) as SupplementFrequency,
    supplementWeekdays: decodeSupplementWeekdays(row.supplement_weekdays),
    supplementDosage: toNullableNumber(row.supplement_dosage),
    supplementDosageUnit: String(row.supplement_dosage_unit) as UnitType,
    note: String(row.note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

interface NormalizedSupplementPlan {
  frequency: SupplementFrequency;
  weekdays: SupplementWeekday[];
  weekdayMask: number;
  dosage: number | null;
  dosageUnit: UnitType;
  isRecommendable: boolean;
}

/** 在数据库边界统一补剂计划，避免 IPC 之外的调用写入无法执行的提醒。 */
function normalizeSupplementPlan(
  input: FoodInput,
  isSupplement: boolean,
  existing?: Food,
): NormalizedSupplementPlan {
  if (!isSupplement) {
    return {
      frequency: 'as_needed',
      weekdays: [],
      weekdayMask: 0,
      dosage: null,
      dosageUnit: 'gram',
      isRecommendable: input.isRecommendable ?? existing?.isRecommendable ?? true,
    };
  }

  const frequency = input.supplementFrequency ?? existing?.supplementFrequency ?? 'as_needed';
  if (!SUPPLEMENT_FREQUENCIES.includes(frequency)) {
    throw new AppError('VALIDATION_ERROR', '补剂服用频率无效。');
  }
  const sourceWeekdays = input.supplementWeekdays ?? existing?.supplementWeekdays ?? [];
  const weekdays = [...new Set(sourceWeekdays)];
  if (
    weekdays.length !== sourceWeekdays.length ||
    weekdays.some((weekday) => !SUPPLEMENT_WEEKDAYS.includes(weekday))
  ) {
    throw new AppError('VALIDATION_ERROR', '补剂服用星期无效或存在重复。');
  }
  if (frequency === 'weekdays' && weekdays.length === 0) {
    throw new AppError('VALIDATION_ERROR', '按星期服用时请至少选择一天。');
  }

  const dosage =
    input.supplementDosage === undefined
      ? (existing?.supplementDosage ?? null)
      : input.supplementDosage;
  if (
    dosage !== null &&
    (typeof dosage !== 'number' || !Number.isFinite(dosage) || dosage <= 0 || dosage > 1_000_000)
  ) {
    throw new AppError('VALIDATION_ERROR', '补剂每次用量必须是有效的正数。');
  }
  if (frequency !== 'as_needed' && dosage === null) {
    throw new AppError('VALIDATION_ERROR', '加入当日推荐前必须填写每次用量。');
  }

  const dosageUnit = input.supplementDosageUnit ?? existing?.supplementDosageUnit ?? 'gram';
  if (dosageUnit !== 'gram' && dosageUnit !== 'serving') {
    throw new AppError('VALIDATION_ERROR', '补剂用量单位无效。');
  }
  const servingGrams =
    input.defaultServingGrams === undefined
      ? (existing?.defaultServingGrams ?? null)
      : input.defaultServingGrams;
  if (dosage !== null && dosageUnit === 'serving' && !servingGrams) {
    throw new AppError('VALIDATION_ERROR', '按份设置补剂用量前必须填写默认每份重量。');
  }

  const normalizedWeekdays = frequency === 'weekdays' ? weekdays : [];
  return {
    frequency,
    weekdays: normalizedWeekdays,
    weekdayMask: encodeSupplementWeekdays(normalizedWeekdays),
    dosage,
    dosageUnit,
    isRecommendable: frequency !== 'as_needed',
  };
}

function mapDietPlan(row: SqlRow): DietPlan {
  return {
    id: toNumber(row.id),
    name: String(row.name),
    goalType: String(row.goal_type) as DietPlan['goalType'],
    mealRatios: {
      breakfast: toNumber(row.breakfast_ratio),
      lunch: toNumber(row.lunch_ratio),
      dinner: toNumber(row.dinner_ratio),
    },
    calculationMode: String(row.calculation_mode) as DietPlanCalculationMode,
    weightSourceMode: String(row.weight_source_mode) as DietPlanWeightSourceMode,
    calculationWeight: toNullableNumber(row.calculation_weight),
    weightSourceDate: toNullableString(row.weight_source_date),
    proteinPerKg: toNullableNumber(row.protein_per_kg),
    carbsPerKg: toNullableNumber(row.carbs_per_kg),
    fatPerKg: toNullableNumber(row.fat_per_kg),
    calories: toNumber(row.target_calories),
    protein: toNumber(row.target_protein),
    carbs: toNumber(row.target_carbs),
    fat: toNumber(row.target_fat),
    isActive: toBoolean(row.is_active),
    startDate: String(row.start_date),
    endDate: toNullableString(row.end_date),
    note: String(row.note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapDietPlanVariant(row: SqlRow): DietPlanVariant {
  return {
    id: toNumber(row.id),
    planId: toNumber(row.plan_id),
    name: String(row.name),
    calculationMode: String(row.calculation_mode) as DietPlanCalculationMode,
    weightSourceMode: String(row.weight_source_mode) as DietPlanWeightSourceMode,
    calculationWeight: toNullableNumber(row.calculation_weight),
    weightSourceDate: toNullableString(row.weight_source_date),
    proteinPerKg: toNullableNumber(row.protein_per_kg),
    carbsPerKg: toNullableNumber(row.carbs_per_kg),
    fatPerKg: toNullableNumber(row.fat_per_kg),
    calories: toNumber(row.target_calories),
    protein: toNumber(row.target_protein),
    carbs: toNumber(row.target_carbs),
    fat: toNumber(row.target_fat),
    note: String(row.note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapDailyPlanSnapshot(row: SqlRow): DailyPlanSnapshot {
  return {
    recordDate: String(row.record_date),
    planId: toNullableNumber(row.plan_id),
    planName: String(row.plan_name),
    variantId: toNullableNumber(row.variant_id),
    variantName: toNullableString(row.variant_name),
    target: {
      calories: toNumber(row.target_calories),
      protein: toNumber(row.target_protein),
      carbs: toNumber(row.target_carbs),
      fat: toNumber(row.target_fat),
    },
    mealRatios: {
      breakfast: toNumber(row.breakfast_ratio),
      lunch: toNumber(row.lunch_ratio),
      dinner: toNumber(row.dinner_ratio),
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

type NormalizedDietPlanInput = Omit<DietPlanInput, 'mealRatios'> & { mealRatios: MealRatios };

function normalizeMealRatiosForDatabase(mealRatios: MealRatios | undefined): MealRatios {
  const ratios = mealRatios ?? DEFAULT_MEAL_RATIOS;
  const entries = CORE_MEAL_TYPES.map((mealType) => [mealType, ratios[mealType]] as const);
  for (const [mealType, value] of entries) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000) {
      const labels: Record<CoreMealType, string> = {
        breakfast: '早餐比例',
        lunch: '午餐比例',
        dinner: '晚餐比例',
      };
      throw new AppError(
        'VALIDATION_ERROR',
        `${labels[mealType]}必须是 0 到 1000 之间的有限数字。`,
      );
    }
  }
  if (entries.reduce((sum, [, value]) => sum + value, 0) <= 0) {
    throw new AppError('VALIDATION_ERROR', '早餐、午餐和晚餐的分配比例不能全部为 0。');
  }
  return {
    breakfast: roundFour(ratios.breakfast),
    lunch: roundFour(ratios.lunch),
    dinner: roundFour(ratios.dinner),
  };
}

/** 饮食方案写入前在数据库边界重复校验公共字段。 */
function normalizeDietPlanInputForDatabase(input: DietPlanInput): NormalizedDietPlanInput {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string') {
    throw new AppError('VALIDATION_ERROR', '方案名称不能为空。');
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > 100) {
    throw new AppError('VALIDATION_ERROR', '方案名称不能为空且不能超过 100 个字符。');
  }
  if (!GOAL_TYPES.includes(input.goalType)) {
    throw new AppError('VALIDATION_ERROR', '目标类型无效。');
  }
  const targets = [
    ['热量目标', input.targetCalories],
    ['蛋白质目标', input.targetProtein],
    ['碳水目标', input.targetCarbs],
    ['脂肪目标', input.targetFat],
  ] as const;
  for (const [label, value] of targets) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) {
      throw new AppError('VALIDATION_ERROR', `${label}必须是 0 到 100000 之间的有限数字。`);
    }
  }
  if (typeof input.startDate !== 'string' || !isValidIsoDate(input.startDate)) {
    throw new AppError('VALIDATION_ERROR', '开始日期无效。');
  }
  const endDate = input.endDate ?? null;
  if (endDate !== null && (typeof endDate !== 'string' || !isValidIsoDate(endDate))) {
    throw new AppError('VALIDATION_ERROR', '结束日期无效。');
  }
  if (endDate !== null && endDate < input.startDate) {
    throw new AppError('VALIDATION_ERROR', '结束日期不能早于开始日期。');
  }
  if (input.note !== undefined && typeof input.note !== 'string') {
    throw new AppError('VALIDATION_ERROR', '方案备注必须是文本。');
  }
  const note = (input.note ?? '').trim();
  if (note.length > 1_000) {
    throw new AppError('VALIDATION_ERROR', '方案备注不能超过 1000 个字符。');
  }
  return {
    ...input,
    name,
    endDate,
    note,
    mealRatios: normalizeMealRatiosForDatabase(input.mealRatios),
  };
}

type NormalizedDietPlanVariantInput = Omit<
  DietPlanVariantInput,
  'note' | keyof DietPlanCalculationInput
> &
  DietPlanCalculationSource & { note: string };

/** 主进程再次验证日型字段，避免绕过 IPC 后写入无效目标。 */
function normalizeDietPlanVariantInput(
  input: DietPlanVariantInput | DietPlanVariantUpdateInput,
  planId: unknown,
): NormalizedDietPlanVariantInput {
  if (typeof planId !== 'number' || !Number.isInteger(planId) || planId <= 0) {
    throw new AppError('VALIDATION_ERROR', '饮食方案 ID 必须是大于 0 的整数。');
  }
  if (!input || typeof input.name !== 'string') {
    throw new AppError('VALIDATION_ERROR', '日型名称不能为空。');
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > 100) {
    throw new AppError('VALIDATION_ERROR', '日型名称不能为空且不能超过 100 个字符。');
  }
  if (input.note !== undefined && typeof input.note !== 'string') {
    throw new AppError('VALIDATION_ERROR', '日型备注必须是文本。');
  }
  const note = (input.note ?? '').trim();
  if (note.length > 1_000) {
    throw new AppError('VALIDATION_ERROR', '日型备注不能超过 1000 个字符。');
  }

  const targetEntries = [
    ['热量目标', input.targetCalories],
    ['蛋白质目标', input.targetProtein],
    ['碳水目标', input.targetCarbs],
    ['脂肪目标', input.targetFat],
  ] as const;
  for (const [label, value] of targetEntries) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) {
      throw new AppError('VALIDATION_ERROR', `${label}必须是 0 到 100000 之间的有限数字。`);
    }
  }

  const calculation = normalizeDietPlanCalculation(input);

  return {
    planId,
    name,
    targetCalories: input.targetCalories,
    targetProtein: input.targetProtein,
    targetCarbs: input.targetCarbs,
    targetFat: input.targetFat,
    note,
    ...calculation,
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError('VALIDATION_ERROR', `${label}必须是大于 0 的整数。`);
  }
}

function assertRecordDate(value: string): void {
  if (typeof value !== 'string' || !isValidIsoDate(value)) {
    throw new AppError('VALIDATION_ERROR', '日期格式必须为有效的 YYYY-MM-DD。');
  }
}

/**
 * 规范化方案或日型的计算来源，并阻止绕过 IPC 的无效数据写入本地数据库。
 */
function normalizeDietPlanCalculation(input: DietPlanCalculationInput): DietPlanCalculationSource {
  const calculationMode = input.calculationMode ?? 'manual';
  if (calculationMode === 'manual') {
    return {
      calculationMode,
      weightSourceMode: 'manual',
      calculationWeight: null,
      weightSourceDate: null,
      proteinPerKg: null,
      carbsPerKg: null,
      fatPerKg: null,
    };
  }
  if (calculationMode !== 'weight_based') {
    throw new AppError('VALIDATION_ERROR', '目标计算方式无效。');
  }

  const weightSourceMode = input.weightSourceMode ?? 'latest';
  if (!DIET_PLAN_WEIGHT_SOURCE_MODES.includes(weightSourceMode)) {
    throw new AppError('VALIDATION_ERROR', '体重来源方式无效。');
  }
  const calculationWeight = input.calculationWeight;
  if (
    typeof calculationWeight !== 'number' ||
    !Number.isFinite(calculationWeight) ||
    calculationWeight <= 0 ||
    calculationWeight > 1_000
  ) {
    throw new AppError('VALIDATION_ERROR', '按体重计算时采用体重必须大于 0 且不超过 1000 kg。');
  }
  const weightSourceDate = input.weightSourceDate;
  if (weightSourceMode === 'latest' && (!weightSourceDate || !isValidIsoDate(weightSourceDate))) {
    throw new AppError('VALIDATION_ERROR', '自动跟随体重时必须提供有效的体重记录日期。');
  }
  if (
    weightSourceMode === 'manual' &&
    weightSourceDate !== null &&
    weightSourceDate !== undefined
  ) {
    throw new AppError('VALIDATION_ERROR', '手动输入体重时不能绑定体重记录日期。');
  }

  const coefficients = [
    ['蛋白质系数', input.proteinPerKg],
    ['碳水系数', input.carbsPerKg],
    ['脂肪系数', input.fatPerKg],
  ] as const;
  for (const [label, value] of coefficients) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 20) {
      throw new AppError('VALIDATION_ERROR', `${label}必须是 0 到 20 之间的有限数字。`);
    }
  }

  return {
    calculationMode,
    weightSourceMode,
    calculationWeight: Number(calculationWeight),
    weightSourceDate: weightSourceMode === 'latest' ? (weightSourceDate ?? null) : null,
    proteinPerKg: Number(input.proteinPerKg),
    carbsPerKg: Number(input.carbsPerKg),
    fatPerKg: Number(input.fatPerKg),
  };
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function mapMealRecord(row: SqlRow): MealRecord {
  return {
    id: toNumber(row.id),
    recordDate: String(row.record_date),
    mealType: String(row.meal_type) as MealType,
    foodId: toNullableNumber(row.food_id),
    foodNameSnapshot: String(row.food_name_snapshot),
    brandSnapshot: String(row.brand_snapshot),
    categorySnapshot: String(row.category_snapshot) as FoodCategory,
    amount: toNumber(row.amount),
    unitType: String(row.unit_type) as UnitType,
    unitNameSnapshot: String(row.unit_name_snapshot),
    servingUnitNameSnapshot: String(row.serving_unit_name_snapshot),
    defaultServingGramsSnapshot: toNullableNumber(row.default_serving_grams_snapshot),
    gramsSnapshot: toNumber(row.grams_snapshot),
    calories: toNumber(row.calories_snapshot),
    protein: toNumber(row.protein_snapshot),
    carbs: toNumber(row.carbs_snapshot),
    fat: toNumber(row.fat_snapshot),
    countInNutritionSnapshot: toBoolean(row.count_in_nutrition_snapshot),
    amountMode: String(row.amount_mode) as MealRecord['amountMode'],
    recommendationMetric: toNullableString(row.recommendation_metric) as NutritionMetric | null,
    sortOrder: toNumber(row.sort_order),
    note: String(row.note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function calculateNutrition(row: SqlRow, grams: number): NutritionValues {
  const ratio = grams / 100;
  return {
    calories: roundFour(toNumber(row.calories_per_100g_snapshot ?? row.calories_per_100g) * ratio),
    protein: roundFour(toNumber(row.protein_per_100g_snapshot ?? row.protein_per_100g) * ratio),
    carbs: roundFour(toNumber(row.carbs_per_100g_snapshot ?? row.carbs_per_100g) * ratio),
    fat: roundFour(toNumber(row.fat_per_100g_snapshot ?? row.fat_per_100g) * ratio),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** 封装主进程中的 SQLite 生命周期和第一阶段业务操作。 */
export class DatabaseService {
  private database: DatabaseSync | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly appVersion = '0.0.0',
  ) {}

  initialize(): void {
    if (this.database) {
      return;
    }

    if (this.databasePath !== ':memory:') {
      mkdirSync(dirname(this.databasePath), { recursive: true });
    }

    const database = new DatabaseSync(this.databasePath);
    this.database = database;
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
      `);
      this.assertDatabaseIntegrity();
      this.runMigrations();
      this.withTransaction(() => this.syncAutomaticWeightBasedTargets());
    } catch (error) {
      database.close();
      this.database = null;
      throw error;
    }
  }

  close(): void {
    if (!this.database) {
      return;
    }
    this.database.close();
    this.database = null;
  }

  /** 创建包含已提交 WAL 内容的一致快照，SQLite 不会覆写已有非空文件。 */
  exportSnapshot(destination: string): void {
    this.connection.prepare('VACUUM INTO ?').run(destination);
    DatabaseService.validateExistingDatabase(destination);
  }

  getDataVersion(): number {
    const row = this.connection.prepare('PRAGMA data_version').get() as SqlRow;
    return Number(row.data_version);
  }

  /** 迁移前明确落盘 WAL；其他连接阻止检查点时拒绝进入删源阶段。 */
  checkpointForMigration(): void {
    const row = this.connection.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as SqlRow;
    if (Number(row.busy) !== 0 || Number(row.log) !== Number(row.checkpointed)) {
      throw new AppError(
        'STORAGE_DATABASE_BUSY',
        '数据库仍被其他连接使用，请关闭相关程序后重试迁移。',
      );
    }
    this.assertDatabaseIntegrity();
  }

  /** 清理旧库期间阻止其他 SQLite 连接改写已经验证的新库。 */
  withMigrationCleanupLock<T>(operation: () => T): T {
    return this.withTransaction(operation);
  }

  static createExistingSnapshot(databasePath: string, destination: string): void {
    DatabaseService.validateExistingDatabase(databasePath);
    const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
    try {
      database.prepare('VACUUM INTO ?').run(destination);
    } finally {
      database.close();
    }
    DatabaseService.validateExistingDatabase(destination);
  }

  /** 在任何可写初始化之前确认所选文件属于本程序，避免改动无关 SQLite 文件。 */
  static validateExistingDatabase(databasePath: string): void {
    if (!statSync(databasePath).isFile()) {
      throw new AppError('STORAGE_DATABASE_INVALID', '所选目录中的数据库路径不是文件。');
    }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
      const integrityRows = database.prepare('PRAGMA quick_check').all() as SqlRow[];
      if (integrityRows.length !== 1 || String(Object.values(integrityRows[0])[0]) !== 'ok') {
        throw new AppError('DATABASE_CORRUPTED', '所选数据库完整性检查失败，原文件未被修改。');
      }
      const tables = new Set(
        (
          database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as SqlRow[]
        ).map((row) => String(row.name)),
      );
      if (
        ![
          'schema_migrations',
          'foods',
          'meal_records',
          'body_records',
          'diet_plans',
          'app_settings',
        ].every((table) => tables.has(table))
      ) {
        throw new AppError(
          'STORAGE_DATABASE_INVALID',
          '所选文件不是本程序的有效数据库，原文件未被修改。',
        );
      }
      const versions = database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as SqlRow[];
      const version = Number(versions.at(-1)?.version ?? 0);
      const userVersion = Number(
        (database.prepare('PRAGMA user_version').get() as SqlRow).user_version,
      );
      if (
        version < 1 ||
        version > DATABASE_SCHEMA_VERSION ||
        version !== userVersion ||
        versions.some((row, index) => Number(row.version) !== index + 1)
      ) {
        throw new AppError(
          'DATABASE_VERSION_UNSUPPORTED',
          '所选数据库版本不受当前程序支持，原文件未被修改。',
        );
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        'STORAGE_DATABASE_INVALID',
        '无法读取所选数据库，请检查文件是否有效及目录权限。原文件未被修改。',
        { cause: error },
      );
    } finally {
      database?.close();
    }
  }

  getAppInfo(): AppInfo {
    const row = this.connection
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as SqlRow;
    return {
      version: this.appVersion,
      databasePath: this.databasePath,
      databaseVersion: toNumber(row.version),
    };
  }

  getDashboard(date: string): DashboardData {
    const bodyRow = this.connection
      .prepare('SELECT * FROM body_records WHERE record_date = ?')
      .get(date) as SqlRow | undefined;
    const activePlanRow = this.connection
      .prepare('SELECT * FROM diet_plans WHERE is_active = 1 LIMIT 1')
      .get() as SqlRow | undefined;
    const dailyPlanRow = this.connection
      .prepare('SELECT * FROM daily_plan_snapshots WHERE record_date = ?')
      .get(date) as SqlRow | undefined;
    const mealRows = this.connection
      .prepare(
        `
        SELECT * FROM meal_records
        WHERE record_date = ?
        ORDER BY CASE meal_type
          WHEN 'breakfast' THEN 0
          WHEN 'lunch' THEN 1
          WHEN 'dinner' THEN 2
          WHEN 'snack' THEN 3
          WHEN 'supplement' THEN 4
          ELSE 5
        END, sort_order, id
      `,
      )
      .all(date) as SqlRow[];

    const meals: Record<MealType, MealRecord[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      snack: [],
      supplement: [],
    };
    const consumed: NutritionValues = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    for (const row of mealRows) {
      const meal = mapMealRecord(row);
      meals[meal.mealType].push(meal);
      if (meal.countInNutritionSnapshot) {
        consumed.calories += meal.calories;
        consumed.protein += meal.protein;
        consumed.carbs += meal.carbs;
        consumed.fat += meal.fat;
      }
    }
    for (const key of Object.keys(consumed) as (keyof NutritionValues)[]) {
      consumed[key] = roundFour(consumed[key]);
    }

    const activePlan = activePlanRow ? mapDietPlan(activePlanRow) : null;
    const dailyPlan = dailyPlanRow ? mapDailyPlanSnapshot(dailyPlanRow) : null;
    const primaryVariant = activePlan ? this.getPrimaryDietPlanVariant(activePlan.id) : null;
    const recommendationWeekday = supplementWeekdayForDate(date);
    const supplementRecommendations = this.listFoods({ kind: 'supplement' }).filter(
      (supplement) =>
        supplement.isRecommendable &&
        (supplement.supplementFrequency === 'daily' ||
          (supplement.supplementFrequency === 'weekdays' &&
            supplement.supplementWeekdays.includes(recommendationWeekday))),
    );
    // 已落盘日期必须继续使用当日目标，切换当前方案不能改写过去的统计口径。
    const target = dailyPlan
      ? dailyPlan.target
      : primaryVariant
        ? {
            calories: primaryVariant.calories,
            protein: primaryVariant.protein,
            carbs: primaryVariant.carbs,
            fat: primaryVariant.fat,
          }
        : activePlan
          ? {
              calories: activePlan.calories,
              protein: activePlan.protein,
              carbs: activePlan.carbs,
              fat: activePlan.fat,
            }
          : { calories: 0, protein: 0, carbs: 0, fat: 0 };
    const mealRatios = dailyPlan?.mealRatios ?? activePlan?.mealRatios ?? DEFAULT_MEAL_RATIOS;
    const consumedByMeal = Object.fromEntries(
      CORE_MEAL_TYPES.map((mealType) => [mealType, this.sumMealRecordNutrition(meals[mealType])]),
    ) as unknown as Record<CoreMealType, NutritionValues>;
    const snackConsumed = this.sumMealRecordNutrition(meals.snack);
    const snackDeductedFrom = this.getSnackDeductionMealType(date);
    const indulgenceMealTypes = CORE_MEAL_TYPES.filter((mealType) =>
      meals[mealType].some((record) => record.amountMode === 'indulgence'),
    );
    const mealAllocation = calculateDailyMealAllocation({
      target,
      mealRatios,
      consumedByMeal,
      snackConsumed,
      snackDeductedFrom,
      indulgenceMealTypes,
    });

    return {
      date,
      bodyRecord: bodyRow ? mapBodyRecord(bodyRow) : null,
      activePlan,
      dailyPlan,
      meals,
      mealAllocation,
      supplementRecommendations,
      nutrition: {
        consumed,
        target,
        remaining: {
          calories: roundFour(target.calories - consumed.calories),
          protein: roundFour(target.protein - consumed.protein),
          carbs: roundFour(target.carbs - consumed.carbs),
          fat: roundFour(target.fat - consumed.fat),
        },
      },
    };
  }

  /** 按日期倒序返回身体记录；导出服务可传入范围，页面调用保持无参。 */
  listBodyRecords(query: DateRangeQuery = {}): BodyRecord[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (query.startDate) {
      conditions.push('record_date >= ?');
      parameters.push(query.startDate);
    }
    if (query.endDate) {
      conditions.push('record_date <= ?');
      parameters.push(query.endDate);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return (
      this.connection
        .prepare(`SELECT * FROM body_records ${whereClause} ORDER BY record_date DESC, id DESC`)
        .all(...parameters) as SqlRow[]
    ).map(mapBodyRecord);
  }

  upsertBodyRecord(input: BodyRecordInput): BodyRecord {
    return this.withTransaction(() => {
      const existing = this.connection
        .prepare('SELECT * FROM body_records WHERE record_date = ?')
        .get(input.recordDate) as SqlRow | undefined;
      const current = existing ? mapBodyRecord(existing) : null;
      const weight = input.weight === undefined ? (current?.weight ?? null) : input.weight;
      const bodyFat =
        input.bodyFatPercentage === undefined
          ? (current?.bodyFatPercentage ?? null)
          : input.bodyFatPercentage;
      const waist =
        input.waistCircumference === undefined
          ? (current?.waistCircumference ?? null)
          : input.waistCircumference;
      const note = input.note === undefined ? (current?.note ?? '') : input.note;

      this.connection
        .prepare(
          `
          INSERT INTO body_records (
            record_date, weight, body_fat_percentage, waist_circumference,
            note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
          ON CONFLICT(record_date) DO UPDATE SET
            weight = excluded.weight,
            body_fat_percentage = excluded.body_fat_percentage,
            waist_circumference = excluded.waist_circumference,
            note = excluded.note,
            updated_at = ${ISO_TIMESTAMP_SQL}
        `,
        )
        .run(input.recordDate, weight, bodyFat, waist, note);

      this.syncAutomaticWeightBasedTargets();
      this.ensureDailyPlanSnapshot(input.recordDate);
      return this.getBodyRecordByDate(input.recordDate);
    });
  }

  deleteBodyRecord(id: number): void {
    this.withTransaction(() => {
      const result = this.connection.prepare('DELETE FROM body_records WHERE id = ?').run(id);
      if (result.changes === 0) {
        throw new AppError('NOT_FOUND', '没有找到要删除的身体数据记录。');
      }
      this.syncAutomaticWeightBasedTargets();
    });
  }

  /**
   * 将已完整校验的身体 CSV 数据一次性写入。
   * 任意一行失败都会回滚，避免出现用户难以识别的半份导入结果。
   */
  importBodyRecords(inputs: readonly BodyRecordInput[]): DatabaseImportResult {
    return this.withTransaction(() => {
      const findExisting = this.connection.prepare(
        'SELECT 1 FROM body_records WHERE record_date = ? LIMIT 1',
      );
      const upsert = this.connection.prepare(`
        INSERT INTO body_records (
          record_date, weight, body_fat_percentage, waist_circumference,
          note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
        ON CONFLICT(record_date) DO UPDATE SET
          weight = excluded.weight,
          body_fat_percentage = excluded.body_fat_percentage,
          waist_circumference = excluded.waist_circumference,
          note = excluded.note,
          updated_at = ${ISO_TIMESTAMP_SQL}
      `);
      let createdCount = 0;
      let updatedCount = 0;
      for (const input of inputs) {
        if (findExisting.get(input.recordDate)) {
          updatedCount += 1;
        } else {
          createdCount += 1;
        }
        upsert.run(
          input.recordDate,
          input.weight ?? null,
          input.bodyFatPercentage ?? null,
          input.waistCircumference ?? null,
          input.note ?? '',
        );
      }
      this.syncAutomaticWeightBasedTargets();
      for (const input of inputs) {
        // 批量导入完成后再建快照，避免新日期保留导入前的旧目标。
        this.ensureDailyPlanSnapshot(input.recordDate);
      }
      return { createdCount, updatedCount };
    });
  }

  listFoods(query: FoodQuery = {}): Food[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (!query.includeArchived) {
      conditions.push('is_archived = 0');
    }
    if (query.category && query.category !== '全部') {
      conditions.push('category = ?');
      parameters.push(query.category);
    }
    if (query.kind === 'food') {
      conditions.push("is_supplement = 0 AND category <> '补剂'");
    } else if (query.kind === 'supplement') {
      conditions.push("(is_supplement = 1 OR category = '补剂')");
    }
    if (query.scope === 'recent') {
      conditions.push('last_used_at IS NOT NULL');
    } else if (query.scope === 'favorite') {
      conditions.push('is_favorite = 1');
    }

    let ranking =
      query.scope === 'recent'
        ? 'last_used_at DESC, usage_count DESC, name COLLATE NOCASE'
        : 'is_favorite DESC, usage_count DESC, last_used_at DESC, name COLLATE NOCASE';
    const search = query.search?.trim();
    if (search) {
      const escaped = escapeLike(search);
      conditions.push(
        `(name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR brand LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR pinyin_initials LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
      );
      parameters.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
      ranking = `
        CASE
          WHEN name = ? COLLATE NOCASE THEN 0
          WHEN name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1
          WHEN name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 2
          WHEN pinyin_initials = ? COLLATE NOCASE THEN 3
          WHEN pinyin_initials LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 4
          WHEN pinyin_initials LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 5
          ELSE 6
        END,
        usage_count DESC, last_used_at DESC, is_favorite DESC, name COLLATE NOCASE
      `;
      parameters.push(search, `${escaped}%`, `%${escaped}%`, search, `${escaped}%`, `%${escaped}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = query.limit === undefined ? '' : 'LIMIT ?';
    if (query.limit !== undefined) {
      parameters.push(query.limit);
    }
    return (
      this.connection
        .prepare(`SELECT * FROM foods ${whereClause} ORDER BY ${ranking} ${limitClause}`)
        .all(...parameters) as SqlRow[]
    ).map(mapFood);
  }

  createFood(input: FoodInput): Food {
    const isSupplement = input.isSupplement === true || input.category === '补剂';
    const countInNutrition =
      input.countInNutrition ??
      (isSupplement ? input.name.includes('鱼油') || input.name.includes('蛋白粉') : true);
    const supplementPlan = normalizeSupplementPlan(input, isSupplement);
    const result = this.connection
      .prepare(
        `
        INSERT INTO foods (
          name, pinyin_initials, brand, category, calories_per_100g, protein_per_100g,
          carbs_per_100g, fat_per_100g, default_serving_grams, unit_name,
          is_supplement, count_in_nutrition, is_favorite, is_recommendable,
          is_archived, usage_count, last_used_at, supplement_frequency,
          supplement_weekdays, supplement_dosage, supplement_dosage_unit,
          note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?, ?,
          ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
      `,
      )
      .run(
        input.name,
        createPinyinInitials(input.name),
        input.brand ?? '',
        input.category,
        input.caloriesPer100g,
        input.proteinPer100g,
        input.carbsPer100g,
        input.fatPer100g,
        input.defaultServingGrams ?? null,
        input.unitName ?? '份',
        isSupplement ? 1 : 0,
        countInNutrition ? 1 : 0,
        input.isFavorite ? 1 : 0,
        supplementPlan.isRecommendable ? 1 : 0,
        supplementPlan.frequency,
        supplementPlan.weekdayMask,
        supplementPlan.dosage,
        supplementPlan.dosageUnit,
        input.note ?? '',
      );
    return this.getFoodById(Number(result.lastInsertRowid), true);
  }

  /** 将已校验的食物 CSV 数据整体新增，历史记录不会被改写。 */
  importFoods(inputs: readonly ImportedFoodRecord[]): DatabaseImportResult {
    return this.withTransaction(() => {
      for (const item of inputs) {
        const food = this.createFood(item.input);
        if (item.isArchived) {
          this.connection
            .prepare(
              `UPDATE foods SET is_archived = 1, is_recommendable = 0,
                updated_at = ${ISO_TIMESTAMP_SQL} WHERE id = ?`,
            )
            .run(food.id);
        }
      }
      return { createdCount: inputs.length, updatedCount: 0 };
    });
  }

  updateFood(id: number, input: FoodInput): Food {
    const existing = this.getFoodById(id, true);
    const isSupplement = input.isSupplement === true || input.category === '补剂';
    const supplementPlan = normalizeSupplementPlan(input, isSupplement, existing);
    const defaultServingGrams =
      input.defaultServingGrams === undefined
        ? existing.defaultServingGrams
        : input.defaultServingGrams;
    const result = this.connection
      .prepare(
        `
        UPDATE foods SET
          name = ?, pinyin_initials = ?, brand = ?, category = ?, calories_per_100g = ?,
          protein_per_100g = ?, carbs_per_100g = ?, fat_per_100g = ?,
          default_serving_grams = ?, unit_name = ?, is_supplement = ?,
          count_in_nutrition = ?, is_favorite = ?, is_recommendable = ?,
          supplement_frequency = ?, supplement_weekdays = ?, supplement_dosage = ?,
          supplement_dosage_unit = ?, note = ?, updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE id = ?
      `,
      )
      .run(
        input.name,
        createPinyinInitials(input.name),
        input.brand ?? '',
        input.category,
        input.caloriesPer100g,
        input.proteinPer100g,
        input.carbsPer100g,
        input.fatPer100g,
        defaultServingGrams,
        input.unitName ?? existing.unitName,
        isSupplement ? 1 : 0,
        (input.countInNutrition ?? existing.countInNutrition) ? 1 : 0,
        (input.isFavorite ?? existing.isFavorite) ? 1 : 0,
        supplementPlan.isRecommendable ? 1 : 0,
        supplementPlan.frequency,
        supplementPlan.weekdayMask,
        supplementPlan.dosage,
        supplementPlan.dosageUnit,
        input.note ?? '',
        id,
      );
    if (result.changes === 0) {
      throw new AppError('NOT_FOUND', '没有找到要更新的食物。');
    }
    return this.getFoodById(id, true);
  }

  setFoodFavorite(id: number, isFavorite: boolean): Food {
    const result = this.connection
      .prepare(
        `
        UPDATE foods
        SET is_favorite = ?, updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE id = ? AND is_archived = 0
      `,
      )
      .run(isFavorite ? 1 : 0, id);
    if (result.changes === 0) {
      throw new AppError('NOT_FOUND', '没有找到可收藏的食物。');
    }
    return this.getFoodById(id);
  }

  archiveFood(id: number): void {
    const result = this.connection
      .prepare(
        `
        UPDATE foods
        SET is_archived = 1, is_recommendable = 0, updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE id = ? AND is_archived = 0
      `,
      )
      .run(id);
    if (result.changes === 0) {
      throw new AppError('NOT_FOUND', '没有找到可删除的食物。');
    }
  }

  createMealRecord(input: MealRecordInput): MealRecord {
    return this.withTransaction(() => {
      const foodRow = this.connection
        .prepare('SELECT * FROM foods WHERE id = ? AND is_archived = 0')
        .get(input.foodId) as SqlRow | undefined;
      if (!foodRow) {
        throw new AppError('FOOD_NOT_FOUND', '所选食物不存在或已停用。');
      }
      if (
        input.mealType === 'supplement' &&
        !toBoolean(foodRow.is_supplement) &&
        String(foodRow.category) !== '补剂'
      ) {
        throw new AppError('VALIDATION_ERROR', '补剂记录只能选择补剂库中的项目。');
      }
      const amountMode = input.amountMode ?? 'manual';
      if (
        amountMode === 'recommended' &&
        !CORE_MEAL_TYPES.includes(input.mealType as CoreMealType)
      ) {
        throw new AppError('VALIDATION_ERROR', '推荐摄入量只适用于早餐、午餐和晚餐。');
      }
      if (
        CORE_MEAL_TYPES.includes(input.mealType as CoreMealType) &&
        this.hasIndulgenceMeal(input.recordDate, input.mealType as CoreMealType)
      ) {
        throw new AppError('INDULGENCE_MEAL_LOCKED', '该餐已设为放纵餐，请先取消放纵餐。');
      }

      this.ensureDailyPlanSnapshot(input.recordDate);
      if (input.mealType === 'snack') this.ensureSnackDeductionMealType(input.recordDate);
      const orderRow = this.connection
        .prepare(
          `
          SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
          FROM meal_records WHERE record_date = ? AND meal_type = ?
        `,
        )
        .get(input.recordDate, input.mealType) as SqlRow;
      const inserted = this.insertFoodIntoMeal(
        { ...input, amountMode },
        foodRow,
        toNumber(orderRow.next_order),
      );
      this.rebalanceDate(input.recordDate);
      const adjusted = this.connection
        .prepare('SELECT * FROM meal_records WHERE id = ?')
        .get(inserted.id) as SqlRow | undefined;
      if (!adjusted) {
        throw new AppError(
          'RECOMMENDATION_NO_REMAINDER',
          '该餐已没有足够的剩余目标，无法保存正数推荐量。',
        );
      }
      return mapMealRecord(adjusted);
    });
  }

  updateMealRecord(input: MealRecordUpdate): MealRecord {
    return this.withTransaction(() => {
      const row = this.connection
        .prepare('SELECT * FROM meal_records WHERE id = ?')
        .get(input.id) as SqlRow | undefined;
      if (!row) {
        throw new AppError('NOT_FOUND', '没有找到要更新的饮食记录。');
      }
      if (String(row.amount_mode) === 'indulgence') {
        throw new AppError('VALIDATION_ERROR', '放纵餐没有食物用量可编辑。');
      }

      const servingGrams = toNullableNumber(row.default_serving_grams_snapshot);
      const amount = normalizeStoredMealAmount(input.amount, input.unitType);
      const grams = this.resolveGrams(amount, input.unitType, servingGrams);
      const nutrition = calculateNutrition(row, grams);
      this.connection
        .prepare(
          `
          UPDATE meal_records SET
            amount = ?, unit_type = ?, unit_name_snapshot = ?, grams_snapshot = ?,
            calories_snapshot = ?, protein_snapshot = ?, carbs_snapshot = ?,
            fat_snapshot = ?, amount_mode = 'manual', recommendation_metric = NULL,
            note = ?, updated_at = ${ISO_TIMESTAMP_SQL}
          WHERE id = ?
        `,
        )
        .run(
          amount,
          input.unitType,
          input.unitType === 'gram' ? '克' : String(row.serving_unit_name_snapshot),
          grams,
          nutrition.calories,
          nutrition.protein,
          nutrition.carbs,
          nutrition.fat,
          input.note ?? '',
          input.id,
        );
      this.rebalanceDate(String(row.record_date));
      return this.getMealRecordById(input.id);
    });
  }

  deleteMealRecord(id: number): void {
    this.withTransaction(() => {
      const row = this.connection
        .prepare('SELECT record_date, meal_type FROM meal_records WHERE id = ?')
        .get(id) as SqlRow | undefined;
      if (!row) throw new AppError('NOT_FOUND', '没有找到要删除的饮食记录。');
      this.connection.prepare('DELETE FROM meal_records WHERE id = ?').run(id);
      const date = String(row.record_date);
      if (String(row.meal_type) === 'snack') this.cleanupSnackDeductionMealType(date);
      this.rebalanceDate(date);
    });
  }

  clearMeal(date: string, mealType: MealType): void {
    this.withTransaction(() => {
      this.connection
        .prepare('DELETE FROM meal_records WHERE record_date = ? AND meal_type = ?')
        .run(date, mealType);
      if (mealType === 'snack') this.cleanupSnackDeductionMealType(date);
      this.rebalanceDate(date);
    });
  }

  reorderMeal(recordIds: number[]): void {
    this.withTransaction(() => {
      const placeholders = recordIds.map(() => '?').join(', ');
      const rows = this.connection
        .prepare(
          `SELECT id, record_date, meal_type FROM meal_records WHERE id IN (${placeholders})`,
        )
        .all(...recordIds) as SqlRow[];
      if (rows.length !== recordIds.length) {
        throw new AppError('NOT_FOUND', '部分饮食记录不存在，无法调整顺序。');
      }
      const date = String(rows[0].record_date);
      const mealType = String(rows[0].meal_type);
      if (rows.some((row) => row.record_date !== date || row.meal_type !== mealType)) {
        throw new AppError('INVALID_REORDER', '只能调整同一天同一餐次内的食物顺序。');
      }

      const countRow = this.connection
        .prepare(
          'SELECT COUNT(*) AS count FROM meal_records WHERE record_date = ? AND meal_type = ?',
        )
        .get(date, mealType) as SqlRow;
      if (toNumber(countRow.count) !== recordIds.length) {
        throw new AppError('INVALID_REORDER', '排序列表必须包含当前餐次的全部记录。');
      }

      const update = this.connection.prepare(
        `UPDATE meal_records SET sort_order = ?, updated_at = ${ISO_TIMESTAMP_SQL} WHERE id = ?`,
      );
      recordIds.forEach((id, index) => update.run(index, id));
      this.rebalanceDate(date);
    });
  }

  setMealIndulgence(input: SetMealIndulgenceInput): void {
    assertRecordDate(input.recordDate);
    if (!CORE_MEAL_TYPES.includes(input.mealType)) {
      throw new AppError('VALIDATION_ERROR', '放纵餐只能设置在早餐、午餐或晚餐。');
    }
    this.withTransaction(() => {
      this.ensureDailyPlanSnapshot(input.recordDate);
      if (input.enabled) {
        this.connection
          .prepare('DELETE FROM meal_records WHERE record_date = ? AND meal_type = ?')
          .run(input.recordDate, input.mealType);
        this.insertIndulgenceMeal(input.recordDate, input.mealType);
      } else {
        this.connection
          .prepare(
            `DELETE FROM meal_records
             WHERE record_date = ? AND meal_type = ? AND amount_mode = 'indulgence'`,
          )
          .run(input.recordDate, input.mealType);
      }
      this.rebalanceDate(input.recordDate);
    });
  }

  listDietPlans(): DietPlan[] {
    return (
      this.connection
        .prepare('SELECT * FROM diet_plans ORDER BY is_active DESC, created_at DESC, id DESC')
        .all() as SqlRow[]
    ).map(mapDietPlan);
  }

  createDietPlan(input: DietPlanInput): DietPlan {
    const normalized = normalizeDietPlanInputForDatabase(input);
    const calculation = normalizeDietPlanCalculation(normalized);
    return this.withTransaction(() => {
      const result = this.connection
        .prepare(
          `
        INSERT INTO diet_plans (
          name, goal_type, target_calories, target_protein, target_carbs,
          target_fat, breakfast_ratio, lunch_ratio, dinner_ratio,
          calculation_mode, weight_source_mode, calculation_weight, weight_source_date,
          protein_per_kg, carbs_per_kg, fat_per_kg,
          is_active, start_date, end_date, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?,
          ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
      `,
        )
        .run(
          normalized.name,
          normalized.goalType,
          normalized.targetCalories,
          normalized.targetProtein,
          normalized.targetCarbs,
          normalized.targetFat,
          normalized.mealRatios.breakfast,
          normalized.mealRatios.lunch,
          normalized.mealRatios.dinner,
          calculation.calculationMode,
          calculation.weightSourceMode,
          calculation.calculationWeight,
          calculation.weightSourceDate,
          calculation.proteinPerKg,
          calculation.carbsPerKg,
          calculation.fatPerKg,
          normalized.startDate,
          normalized.endDate ?? null,
          normalized.note ?? '',
        );
      this.syncAutomaticWeightBasedTargets();
      return this.getDietPlanById(Number(result.lastInsertRowid));
    });
  }

  updateDietPlan(id: number, input: DietPlanInput): DietPlan {
    const normalized = normalizeDietPlanInputForDatabase(input);
    const calculation = normalizeDietPlanCalculation(normalized);
    return this.withTransaction(() => {
      const result = this.connection
        .prepare(
          `
          UPDATE diet_plans SET
            name = ?, goal_type = ?, target_calories = ?, target_protein = ?,
            target_carbs = ?, target_fat = ?, breakfast_ratio = ?, lunch_ratio = ?,
            dinner_ratio = ?, calculation_mode = ?, calculation_weight = ?,
            weight_source_mode = ?, weight_source_date = ?, protein_per_kg = ?,
            carbs_per_kg = ?, fat_per_kg = ?,
            start_date = ?, end_date = ?, note = ?,
            updated_at = ${ISO_TIMESTAMP_SQL}
          WHERE id = ?
        `,
        )
        .run(
          normalized.name,
          normalized.goalType,
          normalized.targetCalories,
          normalized.targetProtein,
          normalized.targetCarbs,
          normalized.targetFat,
          normalized.mealRatios.breakfast,
          normalized.mealRatios.lunch,
          normalized.mealRatios.dinner,
          calculation.calculationMode,
          calculation.calculationWeight,
          calculation.weightSourceMode,
          calculation.weightSourceDate,
          calculation.proteinPerKg,
          calculation.carbsPerKg,
          calculation.fatPerKg,
          normalized.startDate,
          normalized.endDate ?? null,
          normalized.note ?? '',
          id,
        );
      if (result.changes === 0) {
        throw new AppError('NOT_FOUND', '没有找到要更新的饮食方案。');
      }

      this.syncAutomaticWeightBasedTargets();
      const plan = this.getDietPlanById(id);
      if (plan.isActive) {
        // 当天已选择日型时保留其目标；编辑方案信息不能覆盖当天日型。
        const todayRow = this.connection
          .prepare("SELECT date('now', 'localtime') AS today")
          .get() as SqlRow;
        const today = String(todayRow.today);
        const snapshotRow = this.connection
          .prepare('SELECT plan_id, variant_name FROM daily_plan_snapshots WHERE record_date = ?')
          .get(today) as SqlRow | undefined;
        const keepsSelectedVariant =
          snapshotRow !== undefined &&
          toNullableNumber(snapshotRow.plan_id) === plan.id &&
          toNullableString(snapshotRow.variant_name) !== null;
        if (keepsSelectedVariant) {
          // 日型目标和名称属于当日快照；方案改名只同步其显示名称。
          this.connection
            .prepare(
              `UPDATE daily_plan_snapshots SET
                plan_name = ?, breakfast_ratio = ?, lunch_ratio = ?, dinner_ratio = ?,
                updated_at = ${ISO_TIMESTAMP_SQL}
               WHERE record_date = ? AND plan_id = ?`,
            )
            .run(
              plan.name,
              plan.mealRatios.breakfast,
              plan.mealRatios.lunch,
              plan.mealRatios.dinner,
              today,
              plan.id,
            );
          this.rebalanceDate(today);
        } else {
          this.saveDailyPlanSnapshot(today, plan, true, this.getPrimaryDietPlanVariant(plan.id));
        }
      }
      return plan;
    });
  }

  /** 原子复制饮食方案及其全部日型，避免只复制一部分后留下不完整副本。 */
  duplicateDietPlan(id: number, input: DietPlanInput): DietPlan {
    assertPositiveInteger(id, '饮食方案 ID');
    const normalized = normalizeDietPlanInputForDatabase(input);
    const calculation = normalizeDietPlanCalculation(normalized);
    return this.withTransaction(() => {
      this.getDietPlanById(id);
      const result = this.connection
        .prepare(
          `
          INSERT INTO diet_plans (
            name, goal_type, target_calories, target_protein, target_carbs,
            target_fat, breakfast_ratio, lunch_ratio, dinner_ratio,
            calculation_mode, weight_source_mode, calculation_weight, weight_source_date,
            protein_per_kg, carbs_per_kg, fat_per_kg,
            is_active, start_date, end_date, note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?,
            ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
        `,
        )
        .run(
          normalized.name,
          normalized.goalType,
          normalized.targetCalories,
          normalized.targetProtein,
          normalized.targetCarbs,
          normalized.targetFat,
          normalized.mealRatios.breakfast,
          normalized.mealRatios.lunch,
          normalized.mealRatios.dinner,
          calculation.calculationMode,
          calculation.weightSourceMode,
          calculation.calculationWeight,
          calculation.weightSourceDate,
          calculation.proteinPerKg,
          calculation.carbsPerKg,
          calculation.fatPerKg,
          normalized.startDate,
          normalized.endDate ?? null,
          normalized.note ?? '',
        );
      const duplicatedPlanId = Number(result.lastInsertRowid);
      this.connection
        .prepare(
          `
          INSERT INTO diet_plan_variants (
            plan_id, name, target_calories, target_protein, target_carbs,
            target_fat, calculation_mode, weight_source_mode, calculation_weight, weight_source_date,
            protein_per_kg, carbs_per_kg, fat_per_kg, note, created_at, updated_at
          )
          SELECT ?, name, target_calories, target_protein, target_carbs,
            target_fat, calculation_mode, weight_source_mode, calculation_weight, weight_source_date,
            protein_per_kg, carbs_per_kg, fat_per_kg, note,
            ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL}
          FROM diet_plan_variants
          WHERE plan_id = ?
          ORDER BY id
        `,
        )
        .run(duplicatedPlanId, id);
      this.syncAutomaticWeightBasedTargets();
      return this.getDietPlanById(duplicatedPlanId);
    });
  }

  activateDietPlan(id: number): DietPlan {
    return this.withTransaction(() => {
      this.getDietPlanById(id);
      this.connection
        .prepare(
          `UPDATE diet_plans SET is_active = 0, updated_at = ${ISO_TIMESTAMP_SQL} WHERE is_active = 1`,
        )
        .run();
      this.connection
        .prepare(
          `UPDATE diet_plans SET is_active = 1, updated_at = ${ISO_TIMESTAMP_SQL} WHERE id = ?`,
        )
        .run(id);
      const activePlan = this.getDietPlanById(id);
      const todayRow = this.connection
        .prepare("SELECT date('now', 'localtime') AS today")
        .get() as SqlRow;
      this.saveDailyPlanSnapshot(
        String(todayRow.today),
        activePlan,
        true,
        this.getPrimaryDietPlanVariant(activePlan.id),
      );
      return activePlan;
    });
  }

  deleteDietPlan(id: number): void {
    const plan = this.getDietPlanById(id);
    if (plan.isActive) {
      throw new AppError(
        'ACTIVE_PLAN_DELETE_FORBIDDEN',
        '当前饮食方案不能删除，请先切换到其他方案。',
      );
    }
    this.connection.prepare('DELETE FROM diet_plans WHERE id = ?').run(id);
  }

  listDietPlanVariants(planId: number): DietPlanVariant[] {
    assertPositiveInteger(planId, '饮食方案 ID');
    this.getDietPlanById(planId);
    return (
      this.connection
        .prepare(
          `SELECT * FROM diet_plan_variants
           WHERE plan_id = ? ORDER BY created_at ASC, id ASC`,
        )
        .all(planId) as SqlRow[]
    ).map(mapDietPlanVariant);
  }

  createDietPlanVariant(input: DietPlanVariantInput): DietPlanVariant {
    const normalized = normalizeDietPlanVariantInput(input, input?.planId);
    return this.withTransaction(() => {
      this.getDietPlanById(normalized.planId);
      this.assertDietPlanVariantNameAvailable(normalized.planId, normalized.name);
      const result = this.connection
        .prepare(
          `
        INSERT INTO diet_plan_variants (
          plan_id, name, target_calories, target_protein, target_carbs,
          target_fat, calculation_mode, weight_source_mode, calculation_weight, weight_source_date,
          protein_per_kg, carbs_per_kg, fat_per_kg, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
      `,
        )
        .run(
          normalized.planId,
          normalized.name,
          normalized.targetCalories,
          normalized.targetProtein,
          normalized.targetCarbs,
          normalized.targetFat,
          normalized.calculationMode,
          normalized.weightSourceMode,
          normalized.calculationWeight,
          normalized.weightSourceDate,
          normalized.proteinPerKg,
          normalized.carbsPerKg,
          normalized.fatPerKg,
          normalized.note,
        );
      this.syncAutomaticWeightBasedTargets();
      return this.getDietPlanVariantById(Number(result.lastInsertRowid));
    });
  }

  updateDietPlanVariant(id: number, input: DietPlanVariantUpdateInput): DietPlanVariant {
    assertPositiveInteger(id, '日型 ID');
    return this.withTransaction(() => {
      const existing = this.getDietPlanVariantById(id);
      const normalized = normalizeDietPlanVariantInput(input, existing.planId);
      this.assertDietPlanVariantNameAvailable(existing.planId, normalized.name, id);
      this.connection
        .prepare(
          `
          UPDATE diet_plan_variants SET
            name = ?, target_calories = ?, target_protein = ?, target_carbs = ?,
            target_fat = ?, calculation_mode = ?, calculation_weight = ?,
            weight_source_mode = ?, weight_source_date = ?, protein_per_kg = ?,
            carbs_per_kg = ?, fat_per_kg = ?,
            note = ?, updated_at = ${ISO_TIMESTAMP_SQL}
          WHERE id = ?
        `,
        )
        .run(
          normalized.name,
          normalized.targetCalories,
          normalized.targetProtein,
          normalized.targetCarbs,
          normalized.targetFat,
          normalized.calculationMode,
          normalized.calculationWeight,
          normalized.weightSourceMode,
          normalized.weightSourceDate,
          normalized.proteinPerKg,
          normalized.carbsPerKg,
          normalized.fatPerKg,
          normalized.note,
          id,
        );
      this.syncAutomaticWeightBasedTargets();
      const variant = this.getDietPlanVariantById(id);

      // 只刷新今天正在使用的同一日型，其他日期继续保留选择当时的快照。
      const todayRow = this.connection
        .prepare("SELECT date('now', 'localtime') AS today")
        .get() as SqlRow;
      const today = String(todayRow.today);
      const todaySnapshot = this.connection
        .prepare('SELECT variant_id FROM daily_plan_snapshots WHERE record_date = ?')
        .get(today) as SqlRow | undefined;
      if (todaySnapshot && toNullableNumber(todaySnapshot.variant_id) === id) {
        const plan = this.getDietPlanById(variant.planId);
        this.saveDailyPlanSnapshot(today, plan, true, variant);
      }
      return variant;
    });
  }

  deleteDietPlanVariant(id: number): void {
    assertPositiveInteger(id, '日型 ID');
    const result = this.connection.prepare('DELETE FROM diet_plan_variants WHERE id = ?').run(id);
    if (result.changes === 0) {
      throw new AppError('NOT_FOUND', '没有找到要删除的日型计划。');
    }
  }

  setDailyPlanVariant(input: SetDailyPlanVariantInput): DailyPlanSnapshot {
    if (!input || typeof input !== 'object') {
      throw new AppError('VALIDATION_ERROR', '日型计划选择无效。');
    }
    assertRecordDate(input.recordDate);
    assertPositiveInteger(input.variantId, '日型 ID');
    return this.withTransaction(() => {
      const activePlan = this.getActiveDietPlan();
      const variant = this.getDietPlanVariantById(input.variantId);
      if (variant.planId !== activePlan.id) {
        throw new AppError('VARIANT_PLAN_MISMATCH', '只能选择当前饮食方案下的日型计划。');
      }
      this.saveDailyPlanSnapshot(input.recordDate, activePlan, true, variant);
      return this.getDailyPlanSnapshotByDate(input.recordDate);
    });
  }

  clearDailyPlanVariant(recordDate: string): DailyPlanSnapshot {
    assertRecordDate(recordDate);
    return this.withTransaction(() => {
      const activePlan = this.getActiveDietPlan();
      this.saveDailyPlanSnapshot(
        recordDate,
        activePlan,
        true,
        this.getPrimaryDietPlanVariant(activePlan.id),
      );
      return this.getDailyPlanSnapshotByDate(recordDate);
    });
  }

  listFoodCombinations(): FoodCombination[] {
    const rows = this.connection
      .prepare('SELECT id FROM food_combinations ORDER BY updated_at DESC, id DESC')
      .all() as SqlRow[];
    return rows.map((row) => this.getFoodCombinationById(toNumber(row.id)));
  }

  createFoodCombination(input: FoodCombinationInput): FoodCombination {
    return this.withTransaction(() => {
      const normalizedInput = this.normalizeCombinationInput(input);
      const result = this.connection
        .prepare(
          `
          INSERT INTO food_combinations (name, description, created_at, updated_at)
          VALUES (?, ?, ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
        `,
        )
        .run(normalizedInput.name, normalizedInput.description ?? '');
      const combinationId = Number(result.lastInsertRowid);
      this.insertCombinationItems(combinationId, normalizedInput);
      return this.getFoodCombinationById(combinationId);
    });
  }

  updateFoodCombination(id: number, input: FoodCombinationInput): FoodCombination {
    return this.withTransaction(() => {
      this.getFoodCombinationById(id);
      const normalizedInput = this.normalizeCombinationInput(input);
      this.connection
        .prepare(
          `
          UPDATE food_combinations
          SET name = ?, description = ?, updated_at = ${ISO_TIMESTAMP_SQL}
          WHERE id = ?
        `,
        )
        .run(normalizedInput.name, normalizedInput.description ?? '', id);
      this.connection
        .prepare('DELETE FROM food_combination_items WHERE combination_id = ?')
        .run(id);
      this.insertCombinationItems(id, normalizedInput);
      return this.getFoodCombinationById(id);
    });
  }

  deleteFoodCombination(id: number): void {
    const result = this.connection.prepare('DELETE FROM food_combinations WHERE id = ?').run(id);
    if (result.changes === 0) {
      throw new AppError('NOT_FOUND', '没有找到要删除的常用组合。');
    }
  }

  addCombinationToMeal(input: AddCombinationToMealInput): MealRecord[] {
    if (input.mealType === 'supplement') {
      throw new AppError('VALIDATION_ERROR', '常用组合不能加入补剂记录。');
    }
    return this.withTransaction(() => {
      if (
        CORE_MEAL_TYPES.includes(input.mealType as CoreMealType) &&
        this.hasIndulgenceMeal(input.recordDate, input.mealType as CoreMealType)
      ) {
        throw new AppError('INDULGENCE_MEAL_LOCKED', '该餐已设为放纵餐，请先取消放纵餐。');
      }
      const combination = this.getFoodCombinationById(input.combinationId);
      const foods = combination.items.map((item) => {
        const row = this.connection
          .prepare('SELECT * FROM foods WHERE id = ? AND is_archived = 0')
          .get(item.foodId) as SqlRow | undefined;
        if (!row) {
          throw new AppError(
            'FOOD_NOT_FOUND',
            `常用组合中的“${item.food.name}”已停用，无法加入餐次。`,
          );
        }
        if (toBoolean(row.is_supplement) || String(row.category) === '补剂') {
          throw new AppError(
            'VALIDATION_ERROR',
            `常用组合中的“${item.food.name}”属于补剂，请在补剂记录中单独添加。`,
          );
        }
        // 提前校验份量，确保组合内任一无效项目都不会产生部分记录。
        const amount = normalizeStoredMealAmount(item.amount, item.unitType);
        this.resolveGrams(amount, item.unitType, toNullableNumber(row.default_serving_grams));
        return row;
      });

      this.ensureDailyPlanSnapshot(input.recordDate);
      if (input.mealType === 'snack') this.ensureSnackDeductionMealType(input.recordDate);
      const orderRow = this.connection
        .prepare(
          `
          SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
          FROM meal_records WHERE record_date = ? AND meal_type = ?
        `,
        )
        .get(input.recordDate, input.mealType) as SqlRow;
      const firstOrder = toNumber(orderRow.next_order);
      const inserted = combination.items.map((item, index) =>
        this.insertFoodIntoMeal(
          {
            recordDate: input.recordDate,
            mealType: input.mealType,
            foodId: item.foodId,
            amount: item.amount,
            unitType: item.unitType,
          },
          foods[index],
          firstOrder + index,
        ),
      );
      this.rebalanceDate(input.recordDate);
      return inserted.map((record) => this.getMealRecordById(record.id));
    });
  }

  copyMeals(input: CopyMealsInput): CopyMealsResult {
    if (input.sourceDate === input.targetDate) {
      throw new AppError('INVALID_COPY', '来源日期和目标日期不能相同。');
    }
    const mealTypes = [...new Set(input.mealTypes)];
    if (mealTypes.length === 0) {
      throw new AppError('INVALID_COPY', '请至少选择一个要复制的餐次。');
    }

    return this.withTransaction(() => {
      const placeholders = mealTypes.map(() => '?').join(', ');
      const sourceRows = this.connection
        .prepare(
          `
          SELECT * FROM meal_records
          WHERE record_date = ? AND meal_type IN (${placeholders})
          ORDER BY CASE meal_type
            WHEN 'breakfast' THEN 0
            WHEN 'lunch' THEN 1
            WHEN 'dinner' THEN 2
            WHEN 'snack' THEN 3
            WHEN 'supplement' THEN 4
            ELSE 5
          END, sort_order, id
        `,
        )
        .all(input.sourceDate, ...mealTypes) as SqlRow[];

      if (sourceRows.length === 0) {
        return {
          sourceDate: input.sourceDate,
          targetDate: input.targetDate,
          copiedCount: 0,
        };
      }
      if (input.replaceExisting) {
        const copiedMealTypes = [
          ...new Set(sourceRows.map((row) => String(row.meal_type) as MealType)),
        ];
        const copiedPlaceholders = copiedMealTypes.map(() => '?').join(', ');
        this.connection
          .prepare(
            `DELETE FROM meal_records
             WHERE record_date = ? AND meal_type IN (${copiedPlaceholders})`,
          )
          .run(input.targetDate, ...copiedMealTypes);
        if (copiedMealTypes.includes('snack')) {
          this.connection
            .prepare('DELETE FROM daily_meal_settings WHERE record_date = ?')
            .run(input.targetDate);
        }
      }

      const indulgenceMealTypes = new Set(
        sourceRows
          .filter((row) => String(row.amount_mode) === 'indulgence')
          .map((row) => String(row.meal_type) as MealType),
      );
      for (const mealType of indulgenceMealTypes) {
        const targetCount = this.connection
          .prepare(
            'SELECT COUNT(*) AS count FROM meal_records WHERE record_date = ? AND meal_type = ?',
          )
          .get(input.targetDate, mealType) as SqlRow;
        if (toNumber(targetCount.count) > 0) {
          throw new AppError('INVALID_COPY', '放纵餐不能追加到已有餐次，请选择覆盖后再复制。');
        }
      }

      this.ensureDailyPlanSnapshot(input.targetDate);
      const nextOrder = new Map<MealType, number>();
      for (const mealType of mealTypes) {
        const row = this.connection
          .prepare(
            `
            SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
            FROM meal_records WHERE record_date = ? AND meal_type = ?
          `,
          )
          .get(input.targetDate, mealType) as SqlRow;
        nextOrder.set(mealType, toNumber(row.next_order));
      }

      const insert = this.connection.prepare(`
        INSERT INTO meal_records (
          record_date, meal_type, food_id, food_name_snapshot, brand_snapshot,
          category_snapshot, amount, unit_type, unit_name_snapshot,
          serving_unit_name_snapshot, grams_snapshot, default_serving_grams_snapshot,
          calories_per_100g_snapshot, protein_per_100g_snapshot,
          carbs_per_100g_snapshot, fat_per_100g_snapshot, calories_snapshot,
          protein_snapshot, carbs_snapshot, fat_snapshot,
          count_in_nutrition_snapshot, amount_mode, recommendation_metric,
          sort_order, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
      `);
      const updateFoodUsage = this.connection.prepare(`
        UPDATE foods SET
          usage_count = usage_count + 1,
          last_used_at = ${ISO_TIMESTAMP_SQL},
          updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE id = ? AND is_archived = 0
      `);

      for (const row of sourceRows) {
        const mealType = String(row.meal_type) as MealType;
        const sortOrder = nextOrder.get(mealType);
        if (sortOrder === undefined) {
          throw new AppError('INVALID_COPY', '来源记录包含未选择的餐次。');
        }
        insert.run(
          input.targetDate,
          mealType,
          toNullableNumber(row.food_id),
          String(row.food_name_snapshot),
          String(row.brand_snapshot),
          String(row.category_snapshot),
          toNumber(row.amount),
          String(row.unit_type),
          String(row.unit_name_snapshot),
          String(row.serving_unit_name_snapshot),
          toNumber(row.grams_snapshot),
          toNullableNumber(row.default_serving_grams_snapshot),
          toNumber(row.calories_per_100g_snapshot),
          toNumber(row.protein_per_100g_snapshot),
          toNumber(row.carbs_per_100g_snapshot),
          toNumber(row.fat_per_100g_snapshot),
          toNumber(row.calories_snapshot),
          toNumber(row.protein_snapshot),
          toNumber(row.carbs_snapshot),
          toNumber(row.fat_snapshot),
          toNumber(row.count_in_nutrition_snapshot),
          String(row.amount_mode) === 'indulgence' ? 'indulgence' : 'manual',
          null,
          sortOrder,
          String(row.note),
        );
        if (row.food_id !== null && row.food_id !== undefined) {
          updateFoodUsage.run(toNumber(row.food_id));
        }
        nextOrder.set(mealType, sortOrder + 1);
      }

      if (mealTypes.includes('snack')) this.ensureSnackDeductionMealType(input.targetDate);
      this.rebalanceDate(input.targetDate);

      return {
        sourceDate: input.sourceDate,
        targetDate: input.targetDate,
        copiedCount: sourceRows.length,
      };
    });
  }

  listHistory(query: HistoryQuery = {}): HistoryDaySummary[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.startDate) {
      conditions.push('dates.record_date >= ?');
      parameters.push(query.startDate);
    }
    if (query.endDate) {
      conditions.push('dates.record_date <= ?');
      parameters.push(query.endDate);
    }
    if (query.planId !== undefined) {
      conditions.push('snapshot.plan_id = ?');
      parameters.push(query.planId);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.connection
      .prepare(
        `
        WITH dates AS (
          SELECT record_date FROM body_records
          UNION
          SELECT record_date FROM meal_records
        ), meal_totals AS (
          SELECT
            record_date,
            COUNT(*) AS meal_count,
            COALESCE(SUM(CASE WHEN count_in_nutrition_snapshot = 1
              THEN calories_snapshot ELSE 0 END), 0) AS calories,
            COALESCE(SUM(CASE WHEN count_in_nutrition_snapshot = 1
              THEN protein_snapshot ELSE 0 END), 0) AS protein,
            COALESCE(SUM(CASE WHEN count_in_nutrition_snapshot = 1
              THEN carbs_snapshot ELSE 0 END), 0) AS carbs,
            COALESCE(SUM(CASE WHEN count_in_nutrition_snapshot = 1
              THEN fat_snapshot ELSE 0 END), 0) AS fat
          FROM meal_records
          GROUP BY record_date
        )
        SELECT
          dates.record_date,
          body.weight,
          body.body_fat_percentage,
          body.waist_circumference,
          COALESCE(meals.calories, 0) AS calories,
          COALESCE(meals.protein, 0) AS protein,
          COALESCE(meals.carbs, 0) AS carbs,
          COALESCE(meals.fat, 0) AS fat,
          COALESCE(meals.meal_count, 0) AS meal_count,
          snapshot.record_date AS snapshot_date,
          snapshot.plan_id,
          snapshot.plan_name,
          snapshot.variant_name,
          snapshot.target_calories,
          snapshot.target_protein,
          snapshot.target_carbs,
          snapshot.target_fat
        FROM dates
        LEFT JOIN body_records AS body ON body.record_date = dates.record_date
        LEFT JOIN meal_totals AS meals ON meals.record_date = dates.record_date
        LEFT JOIN daily_plan_snapshots AS snapshot
          ON snapshot.record_date = dates.record_date
        ${whereClause}
        ORDER BY dates.record_date DESC
      `,
      )
      .all(...parameters) as SqlRow[];

    return rows
      .map((row) => this.mapHistoryDay(row))
      .filter((summary) => {
        const calorieMatches =
          query.calorieStatus === undefined ||
          query.calorieStatus === 'all' ||
          (query.calorieStatus === 'met'
            ? summary.meetsCalories === true
            : summary.meetsCalories === false);
        const proteinMatches =
          query.proteinStatus === undefined ||
          query.proteinStatus === 'all' ||
          (query.proteinStatus === 'met'
            ? summary.meetsProtein === true
            : summary.meetsProtein === false);
        return calorieMatches && proteinMatches;
      });
  }

  getHistoryDay(date: string): HistoryDayDetail {
    const summary = this.listHistory({ startDate: date, endDate: date }).find(
      (item) => item.recordDate === date,
    );
    if (!summary) {
      throw new AppError('NOT_FOUND', '该日期没有身体或饮食记录。');
    }
    return {
      summary,
      meals: this.getMealsByDate(date),
    };
  }

  /**
   * 返回图表所需的稀疏时间序列。
   * 只有真实存在身体或餐次记录的日期会出现，缺失指标保持 null。
   */
  getTrendData(query: DateRangeQuery = {}): TrendDataPoint[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (query.startDate) {
      conditions.push('dates.record_date >= ?');
      parameters.push(query.startDate);
    }
    if (query.endDate) {
      conditions.push('dates.record_date <= ?');
      parameters.push(query.endDate);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.connection
      .prepare(
        `
        WITH dates AS (
          SELECT record_date FROM body_records
          UNION
          SELECT record_date FROM meal_records
        ), meal_totals AS (
          SELECT
            record_date,
            COUNT(*) AS meal_count,
            SUM(CASE WHEN count_in_nutrition_snapshot = 1
              THEN calories_snapshot ELSE 0 END) AS calories,
            SUM(CASE WHEN count_in_nutrition_snapshot = 1
              THEN protein_snapshot ELSE 0 END) AS protein,
            SUM(CASE WHEN count_in_nutrition_snapshot = 1
              THEN carbs_snapshot ELSE 0 END) AS carbs,
            SUM(CASE WHEN count_in_nutrition_snapshot = 1
              THEN fat_snapshot ELSE 0 END) AS fat
          FROM meal_records
          GROUP BY record_date
        )
        SELECT
          dates.record_date,
          body.weight,
          body.body_fat_percentage,
          body.waist_circumference,
          meals.meal_count,
          meals.calories,
          meals.protein,
          meals.carbs,
          meals.fat,
          snapshot.record_date AS snapshot_date,
          snapshot.target_calories,
          snapshot.target_protein,
          snapshot.target_carbs,
          snapshot.target_fat
        FROM dates
        LEFT JOIN body_records AS body ON body.record_date = dates.record_date
        LEFT JOIN meal_totals AS meals ON meals.record_date = dates.record_date
        LEFT JOIN daily_plan_snapshots AS snapshot
          ON snapshot.record_date = dates.record_date
        ${whereClause}
        ORDER BY dates.record_date ASC
      `,
      )
      .all(...parameters) as SqlRow[];

    return rows.map((row) => {
      const hasMeals = toNumber(row.meal_count ?? 0) > 0;
      const hasTarget = row.snapshot_date !== null && row.snapshot_date !== undefined;
      return {
        recordDate: String(row.record_date),
        weight: toNullableNumber(row.weight),
        bodyFatPercentage: toNullableNumber(row.body_fat_percentage),
        waistCircumference: toNullableNumber(row.waist_circumference),
        calories: hasMeals ? roundFour(toNumber(row.calories)) : null,
        protein: hasMeals ? roundFour(toNumber(row.protein)) : null,
        carbs: hasMeals ? roundFour(toNumber(row.carbs)) : null,
        fat: hasMeals ? roundFour(toNumber(row.fat)) : null,
        target: hasTarget
          ? {
              calories: toNumber(row.target_calories),
              protein: toNumber(row.target_protein),
              carbs: toNumber(row.target_carbs),
              fat: toNumber(row.target_fat),
            }
          : null,
      };
    });
  }

  /** 导出服务使用快照记录，确保食物库后续修改不影响历史明细。 */
  listMealRecordsForExport(query: DateRangeQuery = {}): MealRecord[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (query.startDate) {
      conditions.push('record_date >= ?');
      parameters.push(query.startDate);
    }
    if (query.endDate) {
      conditions.push('record_date <= ?');
      parameters.push(query.endDate);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return (
      this.connection
        .prepare(
          `SELECT * FROM meal_records ${whereClause}
           ORDER BY record_date DESC,
             CASE meal_type WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1
               WHEN 'dinner' THEN 2 WHEN 'snack' THEN 3
               WHEN 'supplement' THEN 4 ELSE 5 END,
             sort_order, id`,
        )
        .all(...parameters) as SqlRow[]
    ).map(mapMealRecord);
  }

  getWindowState(): WindowState | null {
    const row = this.connection
      .prepare("SELECT value FROM app_settings WHERE key = 'window_state'")
      .get() as SqlRow | undefined;
    if (!row) {
      return null;
    }
    try {
      const value = JSON.parse(String(row.value)) as Partial<WindowState>;
      if (
        !Number.isFinite(value.width) ||
        !Number.isFinite(value.height) ||
        Number(value.width) < 1024 ||
        Number(value.height) < 680 ||
        typeof value.isMaximized !== 'boolean'
      ) {
        return null;
      }
      return {
        x: Number.isFinite(value.x) ? Number(value.x) : undefined,
        y: Number.isFinite(value.y) ? Number(value.y) : undefined,
        width: Math.round(Number(value.width)),
        height: Math.round(Number(value.height)),
        isMaximized: value.isMaximized,
      };
    } catch {
      return null;
    }
  }

  saveWindowState(state: WindowState): void {
    this.connection
      .prepare(
        `
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ('window_state', ?, ${ISO_TIMESTAMP_SQL})
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = ${ISO_TIMESTAMP_SQL}
      `,
      )
      .run(JSON.stringify(state));
  }

  private getFoodCombinationById(id: number): FoodCombination {
    const row = this.connection.prepare('SELECT * FROM food_combinations WHERE id = ?').get(id) as
      SqlRow | undefined;
    if (!row) {
      throw new AppError('NOT_FOUND', '没有找到常用组合。');
    }
    const itemRows = this.connection
      .prepare(
        `
        SELECT * FROM food_combination_items
        WHERE combination_id = ?
        ORDER BY sort_order, id
      `,
      )
      .all(id) as SqlRow[];
    const items: FoodCombinationItem[] = itemRows.map((itemRow) => {
      const foodId = toNumber(itemRow.food_id);
      return {
        id: toNumber(itemRow.id),
        combinationId: id,
        foodId,
        amount: toNumber(itemRow.amount),
        unitType: String(itemRow.unit_type) as UnitType,
        sortOrder: toNumber(itemRow.sort_order),
        food: this.getFoodById(foodId, true),
      };
    });
    return {
      id,
      name: String(row.name),
      description: String(row.description),
      items,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private normalizeCombinationInput(input: FoodCombinationInput): FoodCombinationInput {
    if (!input.name.trim()) {
      throw new AppError('VALIDATION_ERROR', '组合名称不能为空。');
    }
    if (input.items.length === 0) {
      throw new AppError('VALIDATION_ERROR', '常用组合至少需要一种食物。');
    }
    const items = input.items.map((item) => {
      if (!Number.isFinite(item.amount) || item.amount <= 0) {
        throw new AppError('VALIDATION_ERROR', '组合中的食物数量必须大于 0。');
      }
      if (item.unitType !== 'gram' && item.unitType !== 'serving') {
        throw new AppError('VALIDATION_ERROR', '组合中的记录单位无效。');
      }
      const foodRow = this.connection
        .prepare('SELECT * FROM foods WHERE id = ? AND is_archived = 0')
        .get(item.foodId) as SqlRow | undefined;
      if (!foodRow) {
        throw new AppError('FOOD_NOT_FOUND', '组合中的食物不存在或已停用。');
      }
      if (toBoolean(foodRow.is_supplement) || String(foodRow.category) === '补剂') {
        throw new AppError('VALIDATION_ERROR', '常用组合只能包含普通食物。');
      }
      const amount = normalizeStoredMealAmount(item.amount, item.unitType);
      this.resolveGrams(amount, item.unitType, toNullableNumber(foodRow.default_serving_grams));
      return { ...item, amount };
    });
    return { ...input, items };
  }

  private insertCombinationItems(combinationId: number, input: FoodCombinationInput): void {
    const insert = this.connection.prepare(`
      INSERT INTO food_combination_items (
        combination_id, food_id, amount, unit_type, sort_order
      ) VALUES (?, ?, ?, ?, ?)
    `);
    input.items.forEach((item, index) => {
      insert.run(combinationId, item.foodId, item.amount, item.unitType, index);
    });
  }

  private insertFoodIntoMeal(
    input: MealRecordInput,
    foodRow: SqlRow,
    sortOrder: number,
  ): MealRecord {
    const servingGrams = toNullableNumber(foodRow.default_serving_grams);
    const amount = normalizeStoredMealAmount(input.amount, input.unitType);
    const grams = this.resolveGrams(amount, input.unitType, servingGrams);
    const nutrition = calculateNutrition(foodRow, grams);
    const result = this.connection
      .prepare(
        `
        INSERT INTO meal_records (
          record_date, meal_type, food_id, food_name_snapshot, brand_snapshot,
          category_snapshot, amount, unit_type, unit_name_snapshot,
          serving_unit_name_snapshot, grams_snapshot, default_serving_grams_snapshot,
          calories_per_100g_snapshot,
          protein_per_100g_snapshot, carbs_per_100g_snapshot, fat_per_100g_snapshot,
          calories_snapshot, protein_snapshot, carbs_snapshot, fat_snapshot,
          count_in_nutrition_snapshot, amount_mode, recommendation_metric,
          sort_order, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
      `,
      )
      .run(
        input.recordDate,
        input.mealType,
        input.foodId,
        String(foodRow.name),
        String(foodRow.brand),
        String(foodRow.category),
        amount,
        input.unitType,
        input.unitType === 'gram' ? '克' : String(foodRow.unit_name),
        String(foodRow.unit_name),
        grams,
        servingGrams,
        toNumber(foodRow.calories_per_100g),
        toNumber(foodRow.protein_per_100g),
        toNumber(foodRow.carbs_per_100g),
        toNumber(foodRow.fat_per_100g),
        nutrition.calories,
        nutrition.protein,
        nutrition.carbs,
        nutrition.fat,
        toBoolean(foodRow.count_in_nutrition) ? 1 : 0,
        input.amountMode ?? 'manual',
        null,
        sortOrder,
        input.note ?? '',
      );

    this.connection
      .prepare(
        `
        UPDATE foods SET
          usage_count = usage_count + 1,
          last_used_at = ${ISO_TIMESTAMP_SQL},
          updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE id = ?
      `,
      )
      .run(input.foodId);
    return this.getMealRecordById(Number(result.lastInsertRowid));
  }

  /** 同步自动来源的模板目标；手动体重与历史快照不在这里改写。 */
  private syncAutomaticWeightBasedTargets(): void {
    if (
      !hasWeightCalculationColumns(this.connection, 'diet_plans') ||
      !hasWeightCalculationColumns(this.connection, 'diet_plan_variants')
    ) {
      return;
    }
    const latestWeightRow = this.connection
      .prepare(
        `
          SELECT record_date, weight
          FROM body_records
          WHERE weight IS NOT NULL AND weight > 0
          ORDER BY record_date DESC, id DESC
          LIMIT 1
        `,
      )
      .get() as SqlRow | undefined;
    if (!latestWeightRow) {
      // 删除全部有效体重后保留最近一次目标，等待下一条体重记录恢复自动计算。
      this.connection
        .prepare(
          `
            UPDATE diet_plans
            SET calculation_weight = NULL, weight_source_date = NULL,
                updated_at = ${ISO_TIMESTAMP_SQL}
            WHERE calculation_mode = 'weight_based' AND weight_source_mode = 'latest'
              AND (calculation_weight IS NOT NULL OR weight_source_date IS NOT NULL)
          `,
        )
        .run();
      this.connection
        .prepare(
          `
            UPDATE diet_plan_variants
            SET calculation_weight = NULL, weight_source_date = NULL,
                updated_at = ${ISO_TIMESTAMP_SQL}
            WHERE calculation_mode = 'weight_based' AND weight_source_mode = 'latest'
              AND (calculation_weight IS NOT NULL OR weight_source_date IS NOT NULL)
          `,
        )
        .run();
      return;
    }

    const weight = toNullableNumber(latestWeightRow.weight);
    if (weight === null || !Number.isFinite(weight) || weight <= 0) return;
    const recordDate = String(latestWeightRow.record_date);
    const updatedPlanIds = new Set<number>();
    const updatedVariantIds = new Set<number>();
    const planUpdate = this.connection.prepare(
      `
        UPDATE diet_plans SET
          calculation_weight = ?, weight_source_date = ?,
          target_calories = ?, target_protein = ?, target_carbs = ?, target_fat = ?,
          updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE id = ?
      `,
    );
    const variantUpdate = this.connection.prepare(
      `
        UPDATE diet_plan_variants SET
          calculation_weight = ?, weight_source_date = ?,
          target_calories = ?, target_protein = ?, target_carbs = ?, target_fat = ?,
          updated_at = ${ISO_TIMESTAMP_SQL}
        WHERE id = ?
      `,
    );
    const plans = this.connection
      .prepare(
        `
          SELECT * FROM diet_plans
          WHERE calculation_mode = 'weight_based' AND weight_source_mode = 'latest'
        `,
      )
      .all() as SqlRow[];
    for (const row of plans) {
      const plan = mapDietPlan(row);
      if (plan.proteinPerKg === null || plan.carbsPerKg === null || plan.fatPerKg === null) {
        continue;
      }
      // 来源未变化时保留当前目标的手动微调，避免保存或启动应用时无故覆盖。
      if (plan.calculationWeight === weight && plan.weightSourceDate === recordDate) {
        continue;
      }
      const target = calculateWeightBasedPlan({
        weight,
        proteinPerKg: plan.proteinPerKg,
        carbsPerKg: plan.carbsPerKg,
        fatPerKg: plan.fatPerKg,
      });
      planUpdate.run(
        weight,
        recordDate,
        target.calories,
        target.protein,
        target.carbs,
        target.fat,
        plan.id,
      );
      updatedPlanIds.add(plan.id);
    }
    const variants = this.connection
      .prepare(
        `
          SELECT * FROM diet_plan_variants
          WHERE calculation_mode = 'weight_based' AND weight_source_mode = 'latest'
        `,
      )
      .all() as SqlRow[];
    for (const row of variants) {
      const variant = mapDietPlanVariant(row);
      if (
        variant.proteinPerKg === null ||
        variant.carbsPerKg === null ||
        variant.fatPerKg === null
      ) {
        continue;
      }
      // 日型同样只在最新体重或其日期变化后重算。
      if (variant.calculationWeight === weight && variant.weightSourceDate === recordDate) {
        continue;
      }
      const target = calculateWeightBasedPlan({
        weight,
        proteinPerKg: variant.proteinPerKg,
        carbsPerKg: variant.carbsPerKg,
        fatPerKg: variant.fatPerKg,
      });
      variantUpdate.run(
        weight,
        recordDate,
        target.calories,
        target.protein,
        target.carbs,
        target.fat,
        variant.id,
      );
      updatedVariantIds.add(variant.id);
    }
    this.refreshTodayAutomaticWeightBasedSnapshot(updatedPlanIds, updatedVariantIds);
  }

  /** 只更新当前活动方案的今天快照，避免回写历史统计与趋势。 */
  private refreshTodayAutomaticWeightBasedSnapshot(
    updatedPlanIds: ReadonlySet<number>,
    updatedVariantIds: ReadonlySet<number>,
  ): void {
    const todayRow = this.connection
      .prepare("SELECT date('now', 'localtime') AS today")
      .get() as SqlRow;
    const today = String(todayRow.today);
    const snapshotRow = this.connection
      .prepare('SELECT plan_id, variant_id FROM daily_plan_snapshots WHERE record_date = ?')
      .get(today) as SqlRow | undefined;
    if (!snapshotRow) return;
    const activePlanRow = this.connection
      .prepare('SELECT * FROM diet_plans WHERE is_active = 1 LIMIT 1')
      .get() as SqlRow | undefined;
    if (!activePlanRow) return;
    const activePlan = mapDietPlan(activePlanRow);
    if (toNullableNumber(snapshotRow.plan_id) !== activePlan.id) return;

    const selectedVariantId = toNullableNumber(snapshotRow.variant_id);
    if (selectedVariantId !== null) {
      const selectedVariant = this.getDietPlanVariantById(selectedVariantId);
      if (
        selectedVariant.calculationMode !== 'weight_based' ||
        selectedVariant.weightSourceMode !== 'latest'
      ) {
        return;
      }
      if (!updatedVariantIds.has(selectedVariant.id)) return;
      this.saveDailyPlanSnapshot(today, activePlan, true, selectedVariant);
      return;
    }
    if (
      activePlan.calculationMode === 'weight_based' &&
      activePlan.weightSourceMode === 'latest' &&
      updatedPlanIds.has(activePlan.id)
    ) {
      this.saveDailyPlanSnapshot(today, activePlan, true);
    }
  }

  private ensureDailyPlanSnapshot(date: string): void {
    const existing = this.connection
      .prepare('SELECT 1 FROM daily_plan_snapshots WHERE record_date = ?')
      .get(date);
    if (existing) {
      return;
    }
    const activePlanRow = this.connection
      .prepare('SELECT * FROM diet_plans WHERE is_active = 1 LIMIT 1')
      .get() as SqlRow | undefined;
    if (activePlanRow) {
      const activePlan = mapDietPlan(activePlanRow);
      this.saveDailyPlanSnapshot(
        date,
        activePlan,
        false,
        this.getPrimaryDietPlanVariant(activePlan.id),
      );
    }
  }

  private saveDailyPlanSnapshot(
    date: string,
    plan: DietPlan,
    overwrite: boolean,
    variant: DietPlanVariant | null = null,
  ): void {
    const conflictClause = overwrite
      ? `DO UPDATE SET
          plan_id = excluded.plan_id,
          plan_name = excluded.plan_name,
          variant_id = excluded.variant_id,
          variant_name = excluded.variant_name,
          target_calories = excluded.target_calories,
          target_protein = excluded.target_protein,
          target_carbs = excluded.target_carbs,
          target_fat = excluded.target_fat,
          breakfast_ratio = excluded.breakfast_ratio,
          lunch_ratio = excluded.lunch_ratio,
          dinner_ratio = excluded.dinner_ratio,
          updated_at = ${ISO_TIMESTAMP_SQL}`
      : 'DO NOTHING';
    this.connection
      .prepare(
        `
        INSERT INTO daily_plan_snapshots (
          record_date, plan_id, plan_name, variant_id, variant_name,
          target_calories, target_protein, target_carbs, target_fat,
          breakfast_ratio, lunch_ratio, dinner_ratio, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})
        ON CONFLICT(record_date) ${conflictClause}
      `,
      )
      .run(
        date,
        plan.id,
        plan.name,
        variant?.id ?? null,
        variant?.name ?? null,
        variant?.calories ?? plan.calories,
        variant?.protein ?? plan.protein,
        variant?.carbs ?? plan.carbs,
        variant?.fat ?? plan.fat,
        plan.mealRatios.breakfast,
        plan.mealRatios.lunch,
        plan.mealRatios.dinner,
      );
    this.rebalanceDate(date);
  }

  private sumMealRecordNutrition(records: readonly MealRecord[]): NutritionValues {
    return records.reduce(
      (sum, record) =>
        record.countInNutritionSnapshot
          ? addNutrition(sum, {
              calories: record.calories,
              protein: record.protein,
              carbs: record.carbs,
              fat: record.fat,
            })
          : sum,
      zeroNutrition(),
    );
  }

  private getCountedMealNutrition(recordDate: string, mealType: CoreMealType): NutritionValues {
    const row = this.connection
      .prepare(
        `SELECT
           COALESCE(SUM(calories_snapshot), 0) AS calories,
           COALESCE(SUM(protein_snapshot), 0) AS protein,
           COALESCE(SUM(carbs_snapshot), 0) AS carbs,
           COALESCE(SUM(fat_snapshot), 0) AS fat
         FROM meal_records
         WHERE record_date = ? AND meal_type = ? AND count_in_nutrition_snapshot = 1`,
      )
      .get(recordDate, mealType) as SqlRow;
    return {
      calories: roundFour(toNumber(row.calories)),
      protein: roundFour(toNumber(row.protein)),
      carbs: roundFour(toNumber(row.carbs)),
      fat: roundFour(toNumber(row.fat)),
    };
  }

  private getSnackNutrition(recordDate: string): NutritionValues {
    const rows = this.connection
      .prepare(
        `SELECT * FROM meal_records
         WHERE record_date = ? AND meal_type = 'snack'
         ORDER BY sort_order, id`,
      )
      .all(recordDate) as SqlRow[];
    return this.sumMealRecordNutrition(rows.map(mapMealRecord));
  }

  private getSnackDeductionMealType(recordDate: string): CoreMealType {
    const row = this.connection
      .prepare('SELECT snack_deduction_meal_type FROM daily_meal_settings WHERE record_date = ?')
      .get(recordDate) as SqlRow | undefined;
    const mealType = row ? String(row.snack_deduction_meal_type) : 'dinner';
    return CORE_MEAL_TYPES.includes(mealType as CoreMealType)
      ? (mealType as CoreMealType)
      : 'dinner';
  }

  private ensureSnackDeductionMealType(recordDate: string): CoreMealType {
    const existing = this.connection
      .prepare('SELECT snack_deduction_meal_type FROM daily_meal_settings WHERE record_date = ?')
      .get(recordDate) as SqlRow | undefined;
    if (existing) return String(existing.snack_deduction_meal_type) as CoreMealType;

    const recordedMealTypes = new Set(
      (
        this.connection
          .prepare(
            `SELECT DISTINCT meal_type FROM meal_records
             WHERE record_date = ? AND meal_type IN ('breakfast', 'lunch', 'dinner')`,
          )
          .all(recordDate) as SqlRow[]
      ).map((row) => String(row.meal_type)),
    );
    const selected =
      CORE_MEAL_TYPES.find((mealType) => !recordedMealTypes.has(mealType)) ?? 'dinner';
    this.connection
      .prepare(
        `INSERT INTO daily_meal_settings (
           record_date, snack_deduction_meal_type, created_at, updated_at
         ) VALUES (?, ?, ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})`,
      )
      .run(recordDate, selected);
    return selected;
  }

  private cleanupSnackDeductionMealType(recordDate: string): void {
    const row = this.connection
      .prepare(
        `SELECT 1 FROM meal_records
         WHERE record_date = ? AND meal_type = 'snack' LIMIT 1`,
      )
      .get(recordDate);
    if (!row) {
      this.connection
        .prepare('DELETE FROM daily_meal_settings WHERE record_date = ?')
        .run(recordDate);
    }
  }

  private hasIndulgenceMeal(recordDate: string, mealType: CoreMealType): boolean {
    return Boolean(
      this.connection
        .prepare(
          `SELECT 1 FROM meal_records
           WHERE record_date = ? AND meal_type = ? AND amount_mode = 'indulgence' LIMIT 1`,
        )
        .get(recordDate, mealType),
    );
  }

  private insertIndulgenceMeal(recordDate: string, mealType: CoreMealType): void {
    this.connection
      .prepare(
        `INSERT INTO meal_records (
           record_date, meal_type, food_id, food_name_snapshot, brand_snapshot,
           category_snapshot, amount, unit_type, unit_name_snapshot,
           serving_unit_name_snapshot, grams_snapshot, default_serving_grams_snapshot,
           calories_per_100g_snapshot, protein_per_100g_snapshot,
           carbs_per_100g_snapshot, fat_per_100g_snapshot, calories_snapshot,
           protein_snapshot, carbs_snapshot, fat_snapshot, count_in_nutrition_snapshot,
           amount_mode, recommendation_metric, sort_order, note, created_at, updated_at
         ) VALUES (?, ?, NULL, '放纵餐', '', '其他', 1, 'serving', '餐', '餐', 100, 100,
           0, 0, 0, 0, 0, 0, 0, 0, 1, 'indulgence', NULL, 0,
           '按本餐动态目标直接记满，不记录具体食物。',
           ${ISO_TIMESTAMP_SQL}, ${ISO_TIMESTAMP_SQL})`,
      )
      .run(recordDate, mealType);
  }

  private updateIndulgenceMeal(rowId: number, target: NutritionValues): void {
    this.connection
      .prepare(
        `UPDATE meal_records SET
           calories_per_100g_snapshot = ?, protein_per_100g_snapshot = ?,
           carbs_per_100g_snapshot = ?, fat_per_100g_snapshot = ?,
           calories_snapshot = ?, protein_snapshot = ?, carbs_snapshot = ?, fat_snapshot = ?,
           updated_at = ${ISO_TIMESTAMP_SQL}
         WHERE id = ? AND amount_mode = 'indulgence'`,
      )
      .run(
        target.calories,
        target.protein,
        target.carbs,
        target.fat,
        target.calories,
        target.protein,
        target.carbs,
        target.fat,
        rowId,
      );
  }

  /** 固定手动项后按顺序重算推荐项；无正数空间的推荐项会被移除。 */
  private adjustRecommendedMealRecords(
    recordDate: string,
    mealType: CoreMealType,
    target: NutritionValues,
  ): void {
    const rows = this.connection
      .prepare(
        `SELECT * FROM meal_records
         WHERE record_date = ? AND meal_type = ?
         ORDER BY sort_order, id`,
      )
      .all(recordDate, mealType) as SqlRow[];
    const manualNutrition = this.sumMealRecordNutrition(
      rows.filter((row) => String(row.amount_mode) === 'manual').map(mapMealRecord),
    );
    let remaining = subtractNutrition(target, manualNutrition);

    for (const row of rows.filter((candidate) => String(candidate.amount_mode) === 'recommended')) {
      const unitType = String(row.unit_type) as UnitType;
      const recommendation = calculateRecommendedMealAmount({
        nutritionPer100g: {
          calories: toNumber(row.calories_per_100g_snapshot),
          protein: toNumber(row.protein_per_100g_snapshot),
          carbs: toNumber(row.carbs_per_100g_snapshot),
          fat: toNumber(row.fat_per_100g_snapshot),
        },
        remaining,
        unitType,
        servingGrams: toNullableNumber(row.default_serving_grams_snapshot),
        unitName: String(row.serving_unit_name_snapshot),
      });
      if (!recommendation || !toBoolean(row.count_in_nutrition_snapshot)) {
        this.connection.prepare('DELETE FROM meal_records WHERE id = ?').run(toNumber(row.id));
        continue;
      }

      const grams = this.resolveGrams(
        recommendation.amount,
        unitType,
        toNullableNumber(row.default_serving_grams_snapshot),
      );
      const nutrition = calculateNutrition(row, grams);
      this.connection
        .prepare(
          `UPDATE meal_records SET
             amount = ?, grams_snapshot = ?, calories_snapshot = ?, protein_snapshot = ?,
             carbs_snapshot = ?, fat_snapshot = ?, recommendation_metric = ?,
             updated_at = ${ISO_TIMESTAMP_SQL}
           WHERE id = ?`,
        )
        .run(
          recommendation.amount,
          grams,
          nutrition.calories,
          nutrition.protein,
          nutrition.carbs,
          nutrition.fat,
          recommendation.limitingMetric,
          toNumber(row.id),
        );
      remaining = subtractNutrition(remaining, nutrition);
    }
  }

  /** 所有写入都在同一事务内重算，确保推荐项和放纵餐不会滞后于后续记录。 */
  private rebalanceDate(recordDate: string): void {
    const snapshot = this.connection
      .prepare('SELECT * FROM daily_plan_snapshots WHERE record_date = ?')
      .get(recordDate) as SqlRow | undefined;
    if (!snapshot) return;

    const dailyTarget: NutritionValues = {
      calories: toNumber(snapshot.target_calories),
      protein: toNumber(snapshot.target_protein),
      carbs: toNumber(snapshot.target_carbs),
      fat: toNumber(snapshot.target_fat),
    };
    const ratios: MealRatios = {
      breakfast: toNumber(snapshot.breakfast_ratio),
      lunch: toNumber(snapshot.lunch_ratio),
      dinner: toNumber(snapshot.dinner_ratio),
    };
    const baseTargets = splitNutritionByMealRatios(dailyTarget, ratios);
    const snackConsumed = this.getSnackNutrition(recordDate);
    const snackDeductedFrom = this.getSnackDeductionMealType(recordDate);
    let carriedOver = zeroNutrition();

    for (const mealType of CORE_MEAL_TYPES) {
      const snackDeduction = mealType === snackDeductedFrom ? snackConsumed : zeroNutrition();
      const adjustedTarget = calculateAdjustedMealTarget(
        baseTargets[mealType],
        carriedOver,
        snackDeduction,
      );
      const indulgenceRow = this.connection
        .prepare(
          `SELECT id FROM meal_records
           WHERE record_date = ? AND meal_type = ? AND amount_mode = 'indulgence' LIMIT 1`,
        )
        .get(recordDate, mealType) as SqlRow | undefined;
      if (indulgenceRow) {
        this.updateIndulgenceMeal(toNumber(indulgenceRow.id), adjustedTarget);
      } else {
        this.adjustRecommendedMealRecords(recordDate, mealType, adjustedTarget);
      }
      const consumed = indulgenceRow
        ? adjustedTarget
        : this.getCountedMealNutrition(recordDate, mealType);
      carriedOver = calculateCarryOver(
        baseTargets[mealType],
        carriedOver,
        snackDeduction,
        consumed,
      );
    }
  }

  private mapHistoryDay(row: SqlRow): HistoryDaySummary {
    const nutrition: NutritionValues = {
      calories: roundFour(toNumber(row.calories)),
      protein: roundFour(toNumber(row.protein)),
      carbs: roundFour(toNumber(row.carbs)),
      fat: roundFour(toNumber(row.fat)),
    };
    const hasSnapshot = row.snapshot_date !== null && row.snapshot_date !== undefined;
    const target = hasSnapshot
      ? {
          calories: toNumber(row.target_calories),
          protein: toNumber(row.target_protein),
          carbs: toNumber(row.target_carbs),
          fat: toNumber(row.target_fat),
        }
      : null;
    return {
      recordDate: String(row.record_date),
      weight: toNullableNumber(row.weight),
      bodyFatPercentage: toNullableNumber(row.body_fat_percentage),
      waistCircumference: toNullableNumber(row.waist_circumference),
      nutrition,
      planId: hasSnapshot ? toNullableNumber(row.plan_id) : null,
      planName: hasSnapshot ? toNullableString(row.plan_name) : null,
      variantName: hasSnapshot ? toNullableString(row.variant_name) : null,
      target,
      mealCount: toNumber(row.meal_count),
      meetsCalories:
        target === null || target.calories <= 0 ? null : nutrition.calories >= target.calories,
      meetsProtein:
        target === null || target.protein <= 0 ? null : nutrition.protein >= target.protein,
    };
  }

  private getMealsByDate(date: string): Record<MealType, MealRecord[]> {
    const meals: Record<MealType, MealRecord[]> = {
      breakfast: [],
      lunch: [],
      dinner: [],
      snack: [],
      supplement: [],
    };
    const rows = this.connection
      .prepare(
        `
        SELECT * FROM meal_records
        WHERE record_date = ?
        ORDER BY CASE meal_type
          WHEN 'breakfast' THEN 0
          WHEN 'lunch' THEN 1
          WHEN 'dinner' THEN 2
          WHEN 'snack' THEN 3
          WHEN 'supplement' THEN 4
          ELSE 5
        END, sort_order, id
      `,
      )
      .all(date) as SqlRow[];
    for (const row of rows) {
      const meal = mapMealRecord(row);
      meals[meal.mealType].push(meal);
    }
    return meals;
  }

  private get connection(): DatabaseSync {
    if (!this.database) {
      throw new AppError('DATABASE_NOT_READY', '本地数据库尚未初始化。');
    }
    return this.database;
  }

  private assertDatabaseIntegrity(): void {
    const row = this.connection.prepare('PRAGMA quick_check').get() as SqlRow;
    const result = String(row.quick_check ?? Object.values(row)[0] ?? '');
    if (result !== 'ok') {
      throw new AppError('DATABASE_CORRUPTED', '本地数据库完整性检查失败，请从备份恢复。');
    }
  }

  private runMigrations(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const appliedRows = this.connection
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as SqlRow[];
    const applied = new Set(appliedRows.map((row) => toNumber(row.version)));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.withTransaction(() => {
        migration.apply(this.connection);
        this.connection
          .prepare(
            `
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, ${ISO_TIMESTAMP_SQL})
          `,
          )
          .run(migration.version, migration.name);
        this.connection.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }

    const current = this.getAppInfo().databaseVersion;
    if (current !== DATABASE_SCHEMA_VERSION) {
      throw new AppError(
        'DATABASE_VERSION_UNSUPPORTED',
        `数据库版本 ${current} 与应用要求的版本 ${DATABASE_SCHEMA_VERSION} 不一致。`,
      );
    }
  }

  private withTransaction<T>(operation: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK');
      } catch {
        // 原始异常更能说明失败原因，回滚异常不会覆盖它。
      }
      throw error;
    }
  }

  private getBodyRecordByDate(date: string): BodyRecord {
    const row = this.connection
      .prepare('SELECT * FROM body_records WHERE record_date = ?')
      .get(date) as SqlRow | undefined;
    if (!row) {
      throw new AppError('NOT_FOUND', '没有找到身体数据记录。');
    }
    return mapBodyRecord(row);
  }

  private getFoodById(id: number, includeArchived = false): Food {
    const row = this.connection
      .prepare(`SELECT * FROM foods WHERE id = ?${includeArchived ? '' : ' AND is_archived = 0'}`)
      .get(id) as SqlRow | undefined;
    if (!row) {
      throw new AppError('NOT_FOUND', '没有找到食物。');
    }
    return mapFood(row);
  }

  private getMealRecordById(id: number): MealRecord {
    const row = this.connection.prepare('SELECT * FROM meal_records WHERE id = ?').get(id) as
      SqlRow | undefined;
    if (!row) {
      throw new AppError('NOT_FOUND', '没有找到饮食记录。');
    }
    return mapMealRecord(row);
  }

  private getDietPlanById(id: number): DietPlan {
    const row = this.connection.prepare('SELECT * FROM diet_plans WHERE id = ?').get(id) as
      SqlRow | undefined;
    if (!row) {
      throw new AppError('NOT_FOUND', '没有找到饮食方案。');
    }
    return mapDietPlan(row);
  }

  private getActiveDietPlan(): DietPlan {
    const row = this.connection
      .prepare('SELECT * FROM diet_plans WHERE is_active = 1 LIMIT 1')
      .get() as SqlRow | undefined;
    if (!row) {
      throw new AppError('ACTIVE_PLAN_REQUIRED', '当前没有启用的饮食方案，请先启用一个方案。');
    }
    return mapDietPlan(row);
  }

  private getDietPlanVariantById(id: number): DietPlanVariant {
    const row = this.connection.prepare('SELECT * FROM diet_plan_variants WHERE id = ?').get(id) as
      SqlRow | undefined;
    if (!row) {
      throw new AppError('NOT_FOUND', '没有找到日型计划。');
    }
    return mapDietPlanVariant(row);
  }

  /** 首个日型作为未显式选择日期的目标来源，不额外暴露一份“主方案默认”。 */
  private getPrimaryDietPlanVariant(planId: number): DietPlanVariant | null {
    const row = this.connection
      .prepare(
        `SELECT * FROM diet_plan_variants
         WHERE plan_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      )
      .get(planId) as SqlRow | undefined;
    return row ? mapDietPlanVariant(row) : null;
  }

  private getDailyPlanSnapshotByDate(recordDate: string): DailyPlanSnapshot {
    const row = this.connection
      .prepare('SELECT * FROM daily_plan_snapshots WHERE record_date = ?')
      .get(recordDate) as SqlRow | undefined;
    if (!row) {
      throw new AppError('NOT_FOUND', '没有找到该日期的饮食目标。');
    }
    return mapDailyPlanSnapshot(row);
  }

  private assertDietPlanVariantNameAvailable(
    planId: number,
    name: string,
    excludedId?: number,
  ): void {
    const row = this.connection
      .prepare(
        `SELECT 1 FROM diet_plan_variants
         WHERE plan_id = ? AND name = ? COLLATE NOCASE
           AND (? IS NULL OR id <> ?)
         LIMIT 1`,
      )
      .get(planId, name, excludedId ?? null, excludedId ?? null);
    if (row) {
      throw new AppError('DUPLICATE_VARIANT_NAME', '同一饮食方案下不能使用重复的日型名称。');
    }
  }

  private resolveGrams(amount: number, unitType: UnitType, servingGrams: number | null): number {
    if (unitType === 'gram') {
      return roundFour(amount);
    }
    if (servingGrams === null || servingGrams <= 0) {
      throw new AppError('SERVING_WEIGHT_MISSING', '该食物没有有效的默认每份重量。');
    }
    return roundFour(amount * servingGrams);
  }
}
