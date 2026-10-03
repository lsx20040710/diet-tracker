import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';

import ExcelJS from 'exceljs';

import {
  CHART_CSV_LIMITS,
  EXPORT_DATA_KINDS,
  FOOD_CATEGORIES,
  SUPPLEMENT_WEEKDAYS,
  type BodyRecordInput,
  type ChartCsvExportInput,
  type ChartImageExportInput,
  type DateRangeQuery,
  type DietPlanWeightSourceMode,
  type ExportDataKind,
  type FoodCategory,
  type FoodInput,
  type ImportDataKind,
  type MealType,
  type SupplementFrequency,
  type SupplementWeekday,
} from '../src/types/models';
import { type DatabaseImportResult, DatabaseService, type ImportedFoodRecord } from './database';
import { AppError } from './errors';
import { bodyRecordInputSchema, foodInputSchema } from './ipc/schemas';

export type CsvCell = string | number | boolean | null | undefined;

export interface ParsedCsvRow {
  lineNumber: number;
  values: string[];
}

export interface ParsedCsvDocument {
  headers: string[];
  rows: ParsedCsvRow[];
}

export interface CsvParseLimits {
  maxColumns?: number;
  maxDataRows?: number;
  maxFieldCharacters?: number;
}

export interface ExportTable {
  sheetName: string;
  headers: string[];
  widths: number[];
  rows: CsvCell[][];
}

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_CHART_BYTES = 20 * 1024 * 1024;
const MAX_CSV_COLUMNS = 64;
const MAX_CSV_DATA_ROWS = 50_000;
const MAX_CSV_FIELD_CHARACTERS = 10_000;
const MAX_CSV_PHYSICAL_LINES = 200_000;
const MAX_PNG_DIMENSION = 8_192;
const MAX_PNG_PIXELS = 40_000_000;
const MAX_PNG_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
const CSV_BOM = '\uFEFF';

export const BODY_RECORD_CSV_HEADERS = [
  '日期',
  '体重(kg)',
  '体脂率(%)',
  '腰围(cm)',
  '备注',
] as const;

const LEGACY_FOOD_CSV_HEADERS = [
  '名称',
  '品牌',
  '分类',
  '每100克热量(kcal)',
  '每100克蛋白质(g)',
  '每100克碳水(g)',
  '每100克脂肪(g)',
  '默认每份重量(g)',
  '份单位',
  '是否补剂',
  '是否计入营养统计',
  '是否常用',
  '是否可推荐',
  '是否停用',
  '备注',
] as const;

export const FOOD_CSV_HEADERS = [
  ...LEGACY_FOOD_CSV_HEADERS.slice(0, 13),
  '补剂服用频率',
  '补剂服用星期',
  '补剂每次用量',
  '补剂用量单位',
  ...LEGACY_FOOD_CSV_HEADERS.slice(13),
] as const;

const MEAL_RECORD_HEADERS = [
  '日期',
  '餐次',
  '食物名称',
  '品牌',
  '分类',
  '数量',
  '记录单位',
  '实际重量(g)',
  '热量(kcal)',
  '蛋白质(g)',
  '碳水(g)',
  '脂肪(g)',
  '是否计入营养统计',
  '记录模式',
  '备注',
] as const;

const NUTRITION_SUMMARY_HEADERS = [
  '日期',
  '热量(kcal)',
  '蛋白质(g)',
  '碳水(g)',
  '脂肪(g)',
  '目标热量(kcal)',
  '目标蛋白质(g)',
  '目标碳水(g)',
  '目标脂肪(g)',
  '饮食方案',
  '日型计划',
] as const;

const DIET_PLAN_HEADERS = [
  '方案名称',
  '日型名称',
  '目标类型',
  '计算方式',
  '体重来源',
  '采用体重(kg)',
  '体重记录日期',
  '蛋白质系数(g/kg)',
  '碳水系数(g/kg)',
  '脂肪系数(g/kg)',
  '热量目标(kcal)',
  '蛋白质目标(g)',
  '碳水目标(g)',
  '脂肪目标(g)',
  '早餐比例',
  '午餐比例',
  '晚餐比例',
  '是否当前方案',
  '开始日期',
  '结束日期',
  '备注',
] as const;

const FOOD_COMBINATION_HEADERS = [
  '组合名称',
  '组合说明',
  '食物名称',
  '品牌',
  '数量',
  '记录单位',
  '排序',
] as const;

function formatDietPlanWeightSource(mode: DietPlanWeightSourceMode): string {
  return mode === 'latest' ? '自动跟随最新体重' : '手动输入体重';
}

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
  supplement: '补剂记录',
};

function protectCsvText(value: string): string {
  // Excel 会把这些前缀解释为公式；增加文本前缀可阻断 CSV 公式注入。
  return hasDangerousCsvPrefix(value) ? `'${value}` : value;
}

function restoreProtectedCsvText(value: string): string {
  return value.startsWith("'") && hasDangerousCsvPrefix(value.slice(1)) ? value.slice(1) : value;
}

function hasDangerousCsvPrefix(value: string): boolean {
  let index = 0;
  while (value[index] === "'") index += 1;
  const codePoint = value.codePointAt(index);
  return (
    codePoint !== undefined &&
    ('=+-@'.includes(value[index]) || codePoint <= 0x1f || codePoint === 0x7f)
  );
}

function encodeCsvCell(cell: CsvCell): string {
  const raw = cell === null || cell === undefined ? '' : String(cell);
  const safe = typeof cell === 'string' ? protectCsvText(raw) : raw;
  return /[",\r\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** 生成带 UTF-8 BOM 的 RFC 4180 CSV，便于 Windows Excel 正确识别中文。 */
export function serializeCsv(headers: readonly string[], rows: readonly CsvCell[][]): string {
  const lines = [headers.map(encodeCsvCell).join(',')];
  for (const row of rows) {
    if (row.length !== headers.length) {
      throw new AppError('CSV_EXPORT_INVALID', 'CSV 导出列数与表头不一致。');
    }
    lines.push(row.map(encodeCsvCell).join(','));
  }
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

function csvError(lineNumber: number, message: string): AppError {
  return new AppError('CSV_IMPORT_INVALID', `第 ${lineNumber} 行：${message}`);
}

/**
 * 解析 RFC 4180 CSV，并保留每行在原文件中的起始行号。
 * 引号内换行属于同一条记录，错误信息仍指向该记录的起始行。
 */
export function parseCsv(text: string, limits: CsvParseLimits = {}): ParsedCsvDocument {
  const source = text.startsWith(CSV_BOM) ? text.slice(1) : text;
  if (source.length === 0) {
    throw new AppError('CSV_IMPORT_INVALID', 'CSV 文件为空。');
  }

  const maxColumns = limits.maxColumns ?? MAX_CSV_COLUMNS;
  const maxDataRows = limits.maxDataRows ?? MAX_CSV_DATA_ROWS;
  const maxFieldCharacters = limits.maxFieldCharacters ?? MAX_CSV_FIELD_CHARACTERS;
  if (
    !Number.isInteger(maxColumns) ||
    maxColumns <= 0 ||
    !Number.isInteger(maxDataRows) ||
    maxDataRows <= 0 ||
    !Number.isInteger(maxFieldCharacters) ||
    maxFieldCharacters <= 0
  ) {
    throw new AppError('CSV_IMPORT_INVALID', 'CSV 解析限制配置无效。');
  }

  const parsedRows: ParsedCsvRow[] = [];
  let values: string[] = [];
  let field = '';
  let inQuotes = false;
  let closedQuote = false;
  let lineNumber = 1;
  let rowStartLine = 1;

  const appendFieldText = (textToAppend: string): void => {
    if (field.length + textToAppend.length > maxFieldCharacters) {
      throw csvError(rowStartLine, `单个字段不能超过 ${maxFieldCharacters} 个字符。`);
    }
    field += textToAppend;
  };

  const finishField = (): void => {
    if (values.length >= maxColumns) {
      throw csvError(rowStartLine, `每行最多允许 ${maxColumns} 列。`);
    }
    values.push(field);
    field = '';
  };

  const advanceLine = (): void => {
    lineNumber += 1;
    if (lineNumber > MAX_CSV_PHYSICAL_LINES) {
      throw csvError(rowStartLine, `CSV 文件不能超过 ${MAX_CSV_PHYSICAL_LINES} 个物理行。`);
    }
  };

  const finishRow = (): void => {
    finishField();
    if (!(values.length === 1 && values[0] === '')) {
      if (parsedRows.length >= maxDataRows + 1) {
        throw csvError(rowStartLine, `CSV 数据最多允许 ${maxDataRows} 条。`);
      }
      parsedRows.push({ lineNumber: rowStartLine, values });
    }
    values = [];
    closedQuote = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          appendFieldText('"');
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else if (character === '\r' && source[index + 1] === '\n') {
        appendFieldText('\r\n');
        index += 1;
        advanceLine();
      } else {
        appendFieldText(character);
        if (character === '\r' || character === '\n') {
          advanceLine();
        }
      }
      continue;
    }

    if (closedQuote && character !== ',' && character !== '\r' && character !== '\n') {
      throw csvError(rowStartLine, '结束引号后存在无效字符。');
    }
    if (character === '"') {
      if (field.length > 0 || closedQuote) {
        throw csvError(rowStartLine, '字段中的引号格式无效。');
      }
      inQuotes = true;
    } else if (character === ',') {
      finishField();
      closedQuote = false;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      finishRow();
      advanceLine();
      rowStartLine = lineNumber;
    } else {
      appendFieldText(character);
    }
  }

  if (inQuotes) {
    throw csvError(rowStartLine, '引号字段没有闭合。');
  }
  if (field.length > 0 || values.length > 0 || closedQuote) {
    finishRow();
  }
  if (parsedRows.length === 0) {
    throw new AppError('CSV_IMPORT_INVALID', 'CSV 文件没有表头。');
  }
  return {
    headers: parsedRows[0].values,
    rows: parsedRows.slice(1),
  };
}

function validateHeaders(document: ParsedCsvDocument, expected: readonly string[]): void {
  if (
    document.headers.length !== expected.length ||
    document.headers.some((header, index) => header !== expected[index])
  ) {
    throw new AppError(
      'CSV_IMPORT_INVALID',
      `CSV 表头不匹配，必须依次为：${expected.join('、')}。`,
    );
  }
  for (const row of document.rows) {
    if (row.values.length !== expected.length) {
      throw csvError(
        row.lineNumber,
        `应有 ${expected.length} 列，实际为 ${row.values.length} 列。`,
      );
    }
    if (row.values.some((value) => value.includes('\0'))) {
      throw csvError(row.lineNumber, '字段不能包含空字符。');
    }
  }
}

function parseRequiredNumber(value: string, lineNumber: number, label: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw csvError(lineNumber, `${label}不能为空。`);
  }
  const number = Number(trimmed);
  if (!Number.isFinite(number)) {
    throw csvError(lineNumber, `${label}必须是有效数字。`);
  }
  return number;
}

function parseNullableNumber(value: string, lineNumber: number, label: string): number | null {
  return value.trim() === '' ? null : parseRequiredNumber(value, lineNumber, label);
}

function parseBoolean(value: string, lineNumber: number, label: string): boolean {
  const normalized = value.trim().toLocaleLowerCase('zh-CN');
  if (normalized === '是' || normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === '否' || normalized === 'false' || normalized === '0') {
    return false;
  }
  throw csvError(lineNumber, `${label}必须填写“是”或“否”。`);
}

const SUPPLEMENT_FREQUENCY_LABELS: Record<SupplementFrequency, string> = {
  as_needed: '按需',
  daily: '每天',
  weekdays: '每周指定日',
};

const SUPPLEMENT_WEEKDAY_LABELS: Record<SupplementWeekday, string> = {
  monday: '周一',
  tuesday: '周二',
  wednesday: '周三',
  thursday: '周四',
  friday: '周五',
  saturday: '周六',
  sunday: '周日',
};

function parseSupplementFrequency(value: string, lineNumber: number): SupplementFrequency {
  const normalized = value.trim();
  if (normalized === '') return 'as_needed';
  const frequency = Object.entries(SUPPLEMENT_FREQUENCY_LABELS).find(
    ([key, label]) => normalized === key || normalized === label,
  )?.[0] as SupplementFrequency | undefined;
  if (!frequency) {
    throw csvError(lineNumber, '补剂服用频率必须填写“按需”“每天”或“每周指定日”。');
  }
  return frequency;
}

function parseSupplementWeekdays(value: string, lineNumber: number): SupplementWeekday[] {
  const normalized = value.trim();
  if (normalized === '') return [];
  const tokens = normalized.split(/[、,，\s]+/u).filter(Boolean);
  const weekdays = tokens.map((token) => {
    const weekday = SUPPLEMENT_WEEKDAYS.find(
      (candidate) => token === candidate || token === SUPPLEMENT_WEEKDAY_LABELS[candidate],
    );
    if (!weekday) {
      throw csvError(lineNumber, `补剂服用星期“${token}”无效。`);
    }
    return weekday;
  });
  if (new Set(weekdays).size !== weekdays.length) {
    throw csvError(lineNumber, '补剂服用星期不能重复。');
  }
  return weekdays;
}

function parseSupplementDosageUnit(value: string, lineNumber: number): 'gram' | 'serving' {
  const normalized = value.trim().toLocaleLowerCase('zh-CN');
  if (normalized === '' || normalized === 'gram' || normalized === '克' || normalized === 'g') {
    return 'gram';
  }
  if (normalized === 'serving' || normalized === '份') return 'serving';
  throw csvError(lineNumber, '补剂用量单位必须填写“克”或“份”。');
}

function headersMatch(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((header, index) => header === expected[index])
  );
}

function formatSchemaIssue(
  lineNumber: number,
  result: { error: { issues: { message: string }[] } },
): never {
  throw csvError(lineNumber, result.error.issues[0]?.message ?? '数据格式无效。');
}

/** 校验身体数据 CSV 的全部行；返回前不会触碰数据库。 */
export function parseBodyRecordsCsv(text: string): BodyRecordInput[] {
  const document = parseCsv(text, { maxColumns: BODY_RECORD_CSV_HEADERS.length });
  validateHeaders(document, BODY_RECORD_CSV_HEADERS);
  if (document.rows.length === 0) {
    throw new AppError('CSV_IMPORT_INVALID', 'CSV 文件没有可导入的身体数据。');
  }

  const seenDates = new Set<string>();
  return document.rows.map((row) => {
    const input: BodyRecordInput = {
      recordDate: row.values[0].trim(),
      weight: parseNullableNumber(row.values[1], row.lineNumber, '体重'),
      bodyFatPercentage: parseNullableNumber(row.values[2], row.lineNumber, '体脂率'),
      waistCircumference: parseNullableNumber(row.values[3], row.lineNumber, '腰围'),
      note: restoreProtectedCsvText(row.values[4]),
    };
    const result = bodyRecordInputSchema.safeParse(input);
    if (!result.success) {
      formatSchemaIssue(row.lineNumber, result);
    }
    if (seenDates.has(result.data.recordDate)) {
      throw csvError(row.lineNumber, `日期 ${result.data.recordDate} 在文件中重复。`);
    }
    seenDates.add(result.data.recordDate);
    return result.data;
  });
}

/** 校验食物 CSV 的全部行；所有条目都将在事务中作为新食物写入。 */
export function parseFoodsCsv(text: string): ImportedFoodRecord[] {
  const document = parseCsv(text, { maxColumns: FOOD_CSV_HEADERS.length });
  const legacyFormat = headersMatch(document.headers, LEGACY_FOOD_CSV_HEADERS);
  validateHeaders(document, legacyFormat ? LEGACY_FOOD_CSV_HEADERS : FOOD_CSV_HEADERS);
  if (document.rows.length === 0) {
    throw new AppError('CSV_IMPORT_INVALID', 'CSV 文件没有可导入的食物。');
  }

  return document.rows.map((row) => {
    const category = row.values[2].trim();
    if (!FOOD_CATEGORIES.some((candidate) => candidate === category)) {
      throw csvError(row.lineNumber, `食物分类“${category}”无效。`);
    }
    const input: FoodInput = {
      name: restoreProtectedCsvText(row.values[0]).trim(),
      brand: restoreProtectedCsvText(row.values[1]).trim(),
      category: category as FoodCategory,
      caloriesPer100g: parseRequiredNumber(row.values[3], row.lineNumber, '每100克热量'),
      proteinPer100g: parseRequiredNumber(row.values[4], row.lineNumber, '每100克蛋白质'),
      carbsPer100g: parseRequiredNumber(row.values[5], row.lineNumber, '每100克碳水'),
      fatPer100g: parseRequiredNumber(row.values[6], row.lineNumber, '每100克脂肪'),
      defaultServingGrams: parseNullableNumber(row.values[7], row.lineNumber, '默认每份重量'),
      unitName: restoreProtectedCsvText(row.values[8]).trim() || '份',
      isSupplement: parseBoolean(row.values[9], row.lineNumber, '是否补剂'),
      countInNutrition: parseBoolean(row.values[10], row.lineNumber, '是否计入营养统计'),
      isFavorite: parseBoolean(row.values[11], row.lineNumber, '是否常用'),
      isRecommendable: parseBoolean(row.values[12], row.lineNumber, '是否可推荐'),
      supplementFrequency: legacyFormat
        ? 'as_needed'
        : parseSupplementFrequency(row.values[13], row.lineNumber),
      supplementWeekdays: legacyFormat
        ? []
        : parseSupplementWeekdays(row.values[14], row.lineNumber),
      supplementDosage: legacyFormat
        ? null
        : parseNullableNumber(row.values[15], row.lineNumber, '补剂每次用量'),
      supplementDosageUnit: legacyFormat
        ? 'gram'
        : parseSupplementDosageUnit(row.values[16], row.lineNumber),
      note: restoreProtectedCsvText(row.values[legacyFormat ? 14 : 18]),
    };
    const result = foodInputSchema.safeParse(input);
    if (!result.success) {
      formatSchemaIssue(row.lineNumber, result);
    }
    return {
      input: result.data,
      isArchived: parseBoolean(row.values[legacyFormat ? 13 : 17], row.lineNumber, '是否停用'),
    };
  });
}

function yesNo(value: boolean): string {
  return value ? '是' : '否';
}

function blankAsNull(value: string | null | undefined): string | null {
  // Excel 中写入 null 会产生真正的空单元格，避免空共享字符串被部分读取器误解。
  return value === undefined || value === null || value === '' ? null : value;
}

function estimateRowHeight(values: readonly CsvCell[], widths: readonly number[]): number {
  // 中文字符通常占用约两个英文字符宽度，据此为换行文本预留可读高度。
  let maximumLines = 1;
  values.forEach((value, index) => {
    if (typeof value !== 'string' || value.length === 0) return;
    const columnWidth = Math.max(1, widths[index] ?? 16);
    const lineCount = value.split(/\r?\n/u).reduce((total, line) => {
      const displayWidth = [...line].reduce(
        (width, character) => width + ((character.codePointAt(0) ?? 0) <= 0x7f ? 1 : 2),
        0,
      );
      return total + Math.max(1, Math.ceil(displayWidth / columnWidth));
    }, 0);
    maximumLines = Math.max(maximumLines, lineCount);
  });
  return Math.min(72, Math.max(22, maximumLines * 18));
}

/** 按需生成一类导出数据，避免单个 CSV 导出时加载其他全量数据。 */
export function createExportTable(
  database: DatabaseService,
  kind: ExportDataKind,
  query: DateRangeQuery = {},
): ExportTable {
  switch (kind) {
    case 'body_records': {
      const bodies = database.listBodyRecords(query);
      return {
        sheetName: '身体数据',
        headers: [...BODY_RECORD_CSV_HEADERS],
        widths: [14, 12, 12, 12, 32],
        rows: bodies.map((record) => [
          record.recordDate,
          record.weight,
          record.bodyFatPercentage,
          record.waistCircumference,
          blankAsNull(record.note),
        ]),
      };
    }
    case 'meal_records': {
      const meals = database.listMealRecordsForExport(query);
      return {
        sheetName: '每日饮食明细',
        headers: [...MEAL_RECORD_HEADERS],
        widths: [14, 10, 20, 16, 12, 12, 12, 14, 14, 14, 12, 12, 18, 14, 30],
        rows: meals.map((record) => [
          record.recordDate,
          MEAL_LABELS[record.mealType],
          record.foodNameSnapshot,
          blankAsNull(record.brandSnapshot),
          record.categorySnapshot,
          record.amount,
          record.unitType === 'gram' ? '克' : record.servingUnitNameSnapshot,
          record.gramsSnapshot,
          record.calories,
          record.protein,
          record.carbs,
          record.fat,
          yesNo(record.countInNutritionSnapshot),
          record.amountMode === 'recommended'
            ? '自动推荐'
            : record.amountMode === 'indulgence'
              ? '放纵餐'
              : '手动',
          blankAsNull(record.note),
        ]),
      };
    }
    case 'nutrition_summaries': {
      const summaries = database
        .listHistory({ startDate: query.startDate, endDate: query.endDate })
        .filter((summary) => summary.mealCount > 0);
      return {
        sheetName: '每日营养汇总',
        headers: [...NUTRITION_SUMMARY_HEADERS],
        widths: [14, 14, 14, 12, 12, 16, 16, 14, 14, 20, 18],
        rows: summaries.map((summary) => [
          summary.recordDate,
          summary.nutrition.calories,
          summary.nutrition.protein,
          summary.nutrition.carbs,
          summary.nutrition.fat,
          summary.target?.calories ?? null,
          summary.target?.protein ?? null,
          summary.target?.carbs ?? null,
          summary.target?.fat ?? null,
          blankAsNull(summary.planName),
          blankAsNull(summary.variantName),
        ]),
      };
    }
    case 'foods': {
      const foods = database.listFoods({ includeArchived: true });
      return {
        sheetName: '食物库',
        headers: [...FOOD_CSV_HEADERS],
        widths: [20, 16, 12, 20, 20, 18, 18, 20, 12, 12, 20, 12, 14, 16, 24, 16, 14, 12, 32],
        rows: foods.map((food) => [
          food.name,
          blankAsNull(food.brand),
          food.category,
          food.caloriesPer100g,
          food.proteinPer100g,
          food.carbsPer100g,
          food.fatPer100g,
          food.defaultServingGrams,
          food.unitName,
          yesNo(food.isSupplement),
          yesNo(food.countInNutrition),
          yesNo(food.isFavorite),
          yesNo(food.isRecommendable),
          food.isSupplement ? SUPPLEMENT_FREQUENCY_LABELS[food.supplementFrequency] : null,
          food.isSupplement
            ? food.supplementWeekdays
                .map((weekday) => SUPPLEMENT_WEEKDAY_LABELS[weekday])
                .join('、')
            : null,
          food.isSupplement ? food.supplementDosage : null,
          food.isSupplement ? (food.supplementDosageUnit === 'gram' ? '克' : '份') : null,
          yesNo(food.isArchived),
          blankAsNull(food.note),
        ]),
      };
    }
    case 'diet_plans': {
      const plans = database.listDietPlans();
      return {
        sheetName: '饮食方案',
        headers: [...DIET_PLAN_HEADERS],
        widths: [
          20, 18, 14, 14, 20, 16, 16, 20, 18, 18, 18, 18, 16, 16, 16, 12, 12, 12, 14, 14, 32,
        ],
        rows: plans.flatMap((plan) => {
          const baseRow: CsvCell[] = [
            plan.name,
            '基础目标',
            plan.goalType,
            plan.calculationMode === 'weight_based' ? '按体重系数' : '手动设置',
            formatDietPlanWeightSource(plan.weightSourceMode),
            plan.calculationWeight,
            plan.weightSourceDate,
            plan.proteinPerKg,
            plan.carbsPerKg,
            plan.fatPerKg,
            plan.calories,
            plan.protein,
            plan.carbs,
            plan.fat,
            plan.mealRatios.breakfast,
            plan.mealRatios.lunch,
            plan.mealRatios.dinner,
            yesNo(plan.isActive),
            plan.startDate,
            blankAsNull(plan.endDate),
            blankAsNull(plan.note),
          ];
          // 已配置日型时只导出同一方案下的日型，内部兼容目标不再伪装成另一份计划。
          const variantRows = database
            .listDietPlanVariants(plan.id)
            .map((variant) => [
              plan.name,
              variant.name,
              plan.goalType,
              variant.calculationMode === 'weight_based' ? '按体重系数' : '手动设置',
              formatDietPlanWeightSource(variant.weightSourceMode),
              variant.calculationWeight,
              variant.weightSourceDate,
              variant.proteinPerKg,
              variant.carbsPerKg,
              variant.fatPerKg,
              variant.calories,
              variant.protein,
              variant.carbs,
              variant.fat,
              plan.mealRatios.breakfast,
              plan.mealRatios.lunch,
              plan.mealRatios.dinner,
              yesNo(plan.isActive),
              plan.startDate,
              blankAsNull(plan.endDate),
              blankAsNull(variant.note),
            ]);
          return variantRows.length > 0 ? variantRows : [baseRow];
        }),
      };
    }
    case 'food_combinations': {
      const combinations = database.listFoodCombinations();
      return {
        sheetName: '常用组合',
        headers: [...FOOD_COMBINATION_HEADERS],
        widths: [20, 28, 20, 16, 12, 14, 10],
        rows: combinations.flatMap((combination) =>
          combination.items.map((item, index) => [
            combination.name,
            blankAsNull(combination.description),
            item.food.name,
            blankAsNull(item.food.brand),
            item.amount,
            item.unitType === 'gram' ? '克' : item.food.unitName,
            index + 1,
          ]),
        ),
      };
    }
  }
}

/** 生成 Excel 所需的六类数据表，所有工作表共用同一字段口径。 */
export function createExportTables(
  database: DatabaseService,
  query: DateRangeQuery = {},
): Record<ExportDataKind, ExportTable> {
  return Object.fromEntries(
    EXPORT_DATA_KINDS.map((kind) => [kind, createExportTable(database, kind, query)]),
  ) as Record<ExportDataKind, ExportTable>;
}

/** 构建六工作表工作簿，调用方可在写盘前直接检查内容。 */
export function buildExcelWorkbook(
  database: DatabaseService,
  query: DateRangeQuery = {},
): { workbook: ExcelJS.Workbook; recordCount: number } {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '饮食与体重记录助手';
  workbook.created = new Date();
  workbook.modified = new Date();
  const tables = createExportTables(database, query);
  let recordCount = 0;

  for (const table of Object.values(tables)) {
    const worksheet = workbook.addWorksheet(table.sheetName, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    worksheet.columns = table.headers.map((header, index) => ({
      header,
      key: `column_${index}`,
      width: table.widths[index] ?? 16,
    }));
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, table.rows.length + 1), column: table.headers.length },
    };
    const headerRow = worksheet.getRow(1);
    headerRow.height = 24;
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F855A' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    for (const values of table.rows) {
      const row = worksheet.addRow(values);
      row.height = estimateRowHeight(values, table.widths);
      row.eachCell((cell) => {
        if (typeof cell.value === 'number') {
          cell.numFmt = '0.####';
        }
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = {
          bottom: { style: 'hair', color: { argb: 'FFD9E2DD' } },
        };
      });
    }
    recordCount += table.rows.length;
  }
  return { workbook, recordCount };
}

export async function exportExcelToPath(
  database: DatabaseService,
  filePath: string,
  query: DateRangeQuery = {},
): Promise<number> {
  try {
    const { workbook, recordCount } = buildExcelWorkbook(database, query);
    await workbook.xlsx.writeFile(filePath);
    return recordCount;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('EXPORT_FAILED', 'Excel 导出失败，请检查文件夹权限和磁盘空间。', {
      cause: error,
    });
  }
}

export async function exportCsvToPath(
  database: DatabaseService,
  filePath: string,
  kind: ExportDataKind,
  query: DateRangeQuery = {},
): Promise<number> {
  try {
    const table = createExportTable(database, kind, query);
    await writeFile(filePath, serializeCsv(table.headers, table.rows), 'utf8');
    return table.rows.length;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('EXPORT_FAILED', 'CSV 导出失败，请检查文件夹权限和磁盘空间。', {
      cause: error,
    });
  }
}

/** 保存已经渲染端整理的图表数据，并在写盘前再次校验完整表格。 */
export async function saveChartCsvToPath(
  input: ChartCsvExportInput,
  filePath: string,
): Promise<number> {
  if (
    input.headers.length === 0 ||
    input.headers.length > CHART_CSV_LIMITS.maxColumns ||
    new Set(input.headers).size !== input.headers.length ||
    input.headers.some(
      (header) =>
        header.trim().length === 0 || header.length > CHART_CSV_LIMITS.maxStringCharacters,
    )
  ) {
    throw new AppError('CHART_CSV_INVALID', '图表 CSV 表头无效或包含重复列。');
  }
  if (input.rows.length > CHART_CSV_LIMITS.maxRows) {
    throw new AppError(
      'CHART_CSV_INVALID',
      `图表 CSV 最多允许 ${CHART_CSV_LIMITS.maxRows} 条数据。`,
    );
  }
  input.rows.forEach((row, index) => {
    if (row.length !== input.headers.length) {
      throw new AppError('CHART_CSV_INVALID', `图表 CSV 第 ${index + 2} 行列数与表头不一致。`);
    }
    if (
      row.some(
        (cell) =>
          (cell !== null && typeof cell !== 'string' && typeof cell !== 'number') ||
          (typeof cell === 'number' && !Number.isFinite(cell)) ||
          (typeof cell === 'string' && cell.length > CHART_CSV_LIMITS.maxStringCharacters),
      )
    ) {
      throw new AppError('CHART_CSV_INVALID', `图表 CSV 第 ${index + 2} 行包含无效数值。`);
    }
  });

  try {
    let serializedBytes = Buffer.byteLength(CSV_BOM, 'utf8');
    for (const row of [input.headers, ...input.rows]) {
      row.forEach((cell, index) => {
        serializedBytes += Buffer.byteLength(encodeCsvCell(cell), 'utf8');
        if (index > 0) serializedBytes += 1;
      });
      serializedBytes += 2;
      if (serializedBytes > CHART_CSV_LIMITS.maxBytes) {
        throw new AppError('CHART_CSV_TOO_LARGE', '图表 CSV 文件不能超过 5 MB。');
      }
    }
    const content = serializeCsv(input.headers, input.rows);
    await writeFile(filePath, content, 'utf8');
    return input.rows.length;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('EXPORT_FAILED', '图表 CSV 导出失败，请检查文件夹权限和磁盘空间。', {
      cause: error,
    });
  }
}

export async function importCsvFromPath(
  database: DatabaseService,
  filePath: string,
  kind: ImportDataKind,
): Promise<DatabaseImportResult> {
  try {
    if (extname(filePath).toLocaleLowerCase('zh-CN') !== '.csv') {
      throw new AppError('CSV_IMPORT_INVALID', '请选择 .csv 格式的文件。');
    }
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      throw new AppError('CSV_IMPORT_INVALID', '选择的路径不是 CSV 文件。');
    }
    if (fileStats.size > MAX_IMPORT_BYTES) {
      throw new AppError('CSV_IMPORT_TOO_LARGE', 'CSV 文件不能超过 20 MB。');
    }
    const contentBuffer = await readFile(filePath);
    if (contentBuffer.byteLength > MAX_IMPORT_BYTES) {
      throw new AppError('CSV_IMPORT_TOO_LARGE', 'CSV 文件不能超过 20 MB。');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(contentBuffer);
    } catch (error) {
      throw new AppError('CSV_IMPORT_INVALID', 'CSV 文件必须使用 UTF-8 编码。', {
        cause: error,
      });
    }
    if (kind === 'body_records') {
      return database.importBodyRecords(parseBodyRecordsCsv(content));
    }
    return database.importFoods(parseFoodsCsv(content));
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('CSV_IMPORT_FAILED', 'CSV 导入失败，请检查文件内容和读取权限。', {
      cause: error,
    });
  }
}

function decodePngDataUrl(data: string): Buffer {
  const prefix = 'data:image/png;base64,';
  if (!data.startsWith(prefix)) {
    throw new AppError('CHART_IMAGE_INVALID', 'PNG 数据格式无效。');
  }
  const encoded = data.slice(prefix.length);
  const maximumEncodedLength = Math.ceil(MAX_CHART_BYTES / 3) * 4;
  if (encoded.length > maximumEncodedLength) {
    throw new AppError('CHART_IMAGE_TOO_LARGE', '图表图片不能超过 20 MB。');
  }
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new AppError('CHART_IMAGE_INVALID', 'PNG Base64 数据无效。');
  }
  const buffer = Buffer.from(encoded, 'base64');
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < pngSignature.length || !buffer.subarray(0, 8).equals(pngSignature)) {
    throw new AppError('CHART_IMAGE_INVALID', 'PNG 文件签名无效。');
  }
  validatePngChunks(buffer);
  return buffer;
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

const PNG_CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

function pngPassDimension(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function pngScanlinePasses(header: PngHeader): Array<{ rowBytes: number; height: number }> {
  const channels = PNG_CHANNELS[header.colorType];
  const bitsPerPixel = channels * header.bitDepth;
  const definitions = header.interlace === 0 ? ([[0, 0, 1, 1]] as const) : ADAM7_PASSES;

  return definitions.flatMap(([startX, startY, stepX, stepY]) => {
    const width = pngPassDimension(header.width, startX, stepX);
    const height = pngPassDimension(header.height, startY, stepY);
    if (width === 0 || height === 0) return [];
    return [{ rowBytes: Math.ceil((width * bitsPerPixel) / 8), height }];
  });
}

function validatePngImageData(header: PngHeader, imageDataChunks: readonly Buffer[]): void {
  const passes = pngScanlinePasses(header);
  const expectedBytes = passes.reduce(
    (total, pass) => total + (pass.rowBytes + 1) * pass.height,
    0,
  );
  if (expectedBytes <= 0 || expectedBytes > MAX_PNG_DECOMPRESSED_BYTES) {
    throw new AppError('CHART_IMAGE_INVALID', 'PNG 解压后的图像数据过大。');
  }
  const compressed = Buffer.concat(imageDataChunks);
  if (compressed.length === 0) {
    throw new AppError('CHART_IMAGE_INVALID', 'PNG IDAT 图像数据为空。');
  }

  let imageData: Buffer;
  try {
    imageData = inflateSync(compressed, { maxOutputLength: expectedBytes });
  } catch (error) {
    throw new AppError('CHART_IMAGE_INVALID', 'PNG IDAT 图像数据无法解压。', {
      cause: error,
    });
  }
  if (imageData.length !== expectedBytes) {
    throw new AppError('CHART_IMAGE_INVALID', 'PNG 解压后的扫描线长度无效。');
  }

  let offset = 0;
  for (const pass of passes) {
    for (let row = 0; row < pass.height; row += 1) {
      if (imageData[offset] > 4) {
        throw new AppError('CHART_IMAGE_INVALID', 'PNG 扫描线过滤器无效。');
      }
      offset += pass.rowBytes + 1;
    }
  }
}

function validatePngChunks(buffer: Buffer): void {
  let offset = 8;
  let header: PngHeader | null = null;
  let hasPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let hasEnd = false;
  const imageDataChunks: Buffer[] = [];

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw new AppError('CHART_IMAGE_INVALID', 'PNG 数据块不完整。');
    }
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const chunkEnd = dataEnd + 4;
    if (!/^[A-Za-z]{4}$/u.test(chunkType) || dataEnd < dataStart || chunkEnd > buffer.length) {
      throw new AppError('CHART_IMAGE_INVALID', 'PNG 数据块结构无效。');
    }
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32(buffer.subarray(offset + 4, dataEnd)) >>> 0;
    if (expectedCrc !== actualCrc) {
      throw new AppError('CHART_IMAGE_INVALID', 'PNG 数据块校验失败。');
    }

    if (!header) {
      if (chunkType !== 'IHDR' || chunkLength !== 13) {
        throw new AppError('CHART_IMAGE_INVALID', 'PNG 缺少有效的 IHDR 文件头。');
      }
      const width = buffer.readUInt32BE(dataStart);
      const height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8];
      const colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filter = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];
      const validColorDepths = new Set([
        '1:0',
        '2:0',
        '4:0',
        '8:0',
        '16:0',
        '8:2',
        '16:2',
        '1:3',
        '2:3',
        '4:3',
        '8:3',
        '8:4',
        '16:4',
        '8:6',
        '16:6',
      ]);
      if (
        width === 0 ||
        height === 0 ||
        width > MAX_PNG_DIMENSION ||
        height > MAX_PNG_DIMENSION ||
        width * height > MAX_PNG_PIXELS ||
        !validColorDepths.has(`${bitDepth}:${colorType}`) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace > 1
      ) {
        throw new AppError('CHART_IMAGE_INVALID', 'PNG 尺寸或颜色格式无效。');
      }
      header = { width, height, bitDepth, colorType, interlace };
    } else if (chunkType === 'IHDR') {
      throw new AppError('CHART_IMAGE_INVALID', 'PNG 包含重复的 IHDR 文件头。');
    } else {
      const knownCriticalChunk = ['PLTE', 'IDAT', 'IEND'].includes(chunkType);
      if ((chunkType.charCodeAt(0) & 0x20) === 0 && !knownCriticalChunk) {
        throw new AppError('CHART_IMAGE_INVALID', `PNG 包含不支持的 ${chunkType} 关键数据块。`);
      }
    }

    if (chunkType === 'PLTE') {
      if (
        hasPalette ||
        sawImageData ||
        chunkLength === 0 ||
        chunkLength > 768 ||
        chunkLength % 3 !== 0 ||
        header.colorType === 0 ||
        header.colorType === 4 ||
        (header.colorType === 3 && chunkLength / 3 > 2 ** header.bitDepth)
      ) {
        throw new AppError('CHART_IMAGE_INVALID', 'PNG PLTE 调色板数据无效。');
      }
      hasPalette = true;
    }
    if (chunkType === 'IDAT') {
      if (imageDataEnded || (header.colorType === 3 && !hasPalette)) {
        throw new AppError('CHART_IMAGE_INVALID', 'PNG IDAT 图像数据顺序无效。');
      }
      sawImageData = true;
      if (chunkLength > 0) imageDataChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (sawImageData && chunkType !== 'IEND') {
      imageDataEnded = true;
    }
    if (chunkType === 'IEND') {
      if (chunkLength !== 0 || !sawImageData || chunkEnd !== buffer.length) {
        throw new AppError('CHART_IMAGE_INVALID', 'PNG IEND 结尾数据无效。');
      }
      hasEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!header || !sawImageData || !hasEnd || offset !== buffer.length) {
    throw new AppError('CHART_IMAGE_INVALID', 'PNG 文件结构不完整。');
  }
  validatePngImageData(header, imageDataChunks);
}

const ALLOWED_SVG_ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'clippath',
  'rect',
  'path',
  'line',
  'polyline',
  'polygon',
  'circle',
  'ellipse',
  'text',
  'tspan',
  'title',
  'desc',
]);

function validateSvgMarkup(svg: string): void {
  const markup = svg
    .trim()
    .replace(/^<\?xml\s[^>]*\?>\s*/iu, '')
    .trim();
  if (!/^<svg(?:\s|>)[\s\S]*<\/svg>$/iu.test(markup) || /<!|<\?/u.test(markup)) {
    throw new AppError('CHART_IMAGE_INVALID', 'SVG XML 结构无效。');
  }

  const stack: string[] = [];
  const tagPattern = /<(\/?)\s*([A-Za-z][A-Za-z0-9]*)([^<>]*?)(\/?)>/gu;
  let cursor = 0;
  let rootCount = 0;
  for (const match of markup.matchAll(tagPattern)) {
    if (match.index === undefined || /[<>]/u.test(markup.slice(cursor, match.index))) {
      throw new AppError('CHART_IMAGE_INVALID', 'SVG 标签格式无效。');
    }
    const isClosing = match[1] === '/';
    const tagName = match[2].toLocaleLowerCase('en-US');
    const attributes = match[3];
    const isSelfClosing = match[4] === '/';
    if (!ALLOWED_SVG_ELEMENTS.has(tagName)) {
      throw new AppError('CHART_IMAGE_INVALID', `SVG 不允许使用 <${match[2]}> 元素。`);
    }
    if (isClosing) {
      if (attributes.trim().length > 0 || isSelfClosing || stack.pop() !== tagName) {
        throw new AppError('CHART_IMAGE_INVALID', 'SVG 标签嵌套无效。');
      }
    } else {
      if (tagName === 'svg') rootCount += 1;
      // 属性实体和 CSS 转义会在查看器解析后还原，直接拒绝可避免绕过 URI 检查。
      if (/[&\\]/u.test(attributes) || /\/\*/u.test(attributes)) {
        throw new AppError('CHART_IMAGE_INVALID', 'SVG 属性包含不允许的转义内容。');
      }
      const quoteSafe =
        (attributes.match(/"/gu)?.length ?? 0) % 2 === 0 &&
        (attributes.match(/'/gu)?.length ?? 0) % 2 === 0;
      const safeAttributes = attributes.replace(
        /\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/giu,
        '',
      );
      if (
        !quoteSafe ||
        /\s(?:[A-Za-z][\w.-]*:)?(?:href|src)\s*=/iu.test(safeAttributes) ||
        /\son[A-Za-z]+\s*=/iu.test(safeAttributes) ||
        /(?:javascript|data|file|https?):/iu.test(safeAttributes) ||
        /(?:expression\s*\(|@import)/iu.test(safeAttributes) ||
        /url\s*\(\s*(?!#|["']#)/iu.test(safeAttributes) ||
        /\bstyle\s*=\s*(["'])[^"']*(?:url\s*\(|expression\s*\()[^"']*\1/iu.test(safeAttributes)
      ) {
        throw new AppError('CHART_IMAGE_INVALID', 'SVG 属性包含外链或主动内容。');
      }
      if (!isSelfClosing) stack.push(tagName);
    }
    cursor = match.index + match[0].length;
  }
  if (/[<>]/u.test(markup.slice(cursor)) || rootCount !== 1 || stack.length !== 0) {
    throw new AppError('CHART_IMAGE_INVALID', 'SVG 标签嵌套无效。');
  }
}

function encodeSvg(svg: string): Buffer {
  if (Buffer.byteLength(svg, 'utf8') > MAX_CHART_BYTES) {
    throw new AppError('CHART_IMAGE_TOO_LARGE', '图表图片不能超过 20 MB。');
  }
  validateSvgMarkup(svg);
  return Buffer.from(svg, 'utf8');
}

/** 将渲染进程生成的图表内容写入用户刚刚选择的目标路径。 */
export async function saveChartImageToPath(
  input: ChartImageExportInput,
  filePath: string,
): Promise<void> {
  const content = input.format === 'png' ? decodePngDataUrl(input.data) : encodeSvg(input.data);
  if (content.byteLength > MAX_CHART_BYTES) {
    throw new AppError('CHART_IMAGE_TOO_LARGE', '图表图片不能超过 20 MB。');
  }
  try {
    await writeFile(filePath, content);
  } catch (error) {
    throw new AppError('EXPORT_FAILED', '图表图片导出失败，请检查文件夹权限和磁盘空间。', {
      cause: error,
    });
  }
}
