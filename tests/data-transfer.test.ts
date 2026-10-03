import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BODY_RECORD_CSV_HEADERS,
  FOOD_CSV_HEADERS,
  exportCsvToPath,
  exportExcelToPath,
  importCsvFromPath,
  parseBodyRecordsCsv,
  parseCsv,
  parseFoodsCsv,
  saveChartCsvToPath,
  saveChartImageToPath,
  serializeCsv,
} from '../electron/data-transfer';
import { DatabaseService } from '../electron/database';
import {
  chartCsvExportInputSchema,
  dietPlanInputSchema,
  dietPlanVariantInputSchema,
} from '../electron/ipc/schemas';
import type { FoodInput } from '../src/types/models';

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)) >>> 0, data.length + 8);
  return chunk;
}

function createPngDataUrl(imageData: Buffer): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', imageData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function createFoodInput(name: string, overrides: Partial<FoodInput> = {}): FoodInput {
  return {
    name,
    category: '其他',
    caloriesPer100g: 100,
    proteinPer100g: 10,
    carbsPer100g: 20,
    fatPer100g: 5,
    defaultServingGrams: 50,
    unitName: '份',
    ...overrides,
  };
}

function bodyCsv(rows: Array<Array<string | number | null>>): string {
  return serializeCsv(BODY_RECORD_CSV_HEADERS, rows);
}

function foodCsv(rows: Array<Array<string | number | null>>): string {
  return serializeCsv(FOOD_CSV_HEADERS, rows);
}

function validFoodCsvRow(name: string): Array<string | number | null> {
  return [
    name,
    '测试品牌',
    '其他',
    100,
    10,
    20,
    5,
    50,
    '份',
    '否',
    '是',
    '否',
    '是',
    '',
    '',
    null,
    '',
    '否',
    '普通备注',
  ];
}

describe('第三阶段 CSV 与 Excel', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let service: DatabaseService;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'diet-tracker-transfer-test-'));
    databasePath = join(temporaryDirectory, 'diet-tracker.db');
    service = new DatabaseService(databasePath, '0.3.0-test');
    service.initialize();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    service.close();
    rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 20,
    });
  });

  it('CSV 使用 UTF-8 BOM 与 RFC 4180 转义逗号、引号和换行', () => {
    const text = serializeCsv(
      ['名称', '备注'],
      [
        ['鸡胸肉,原味', '第一行\n第二行“中文”'],
        ['带"引号"食物', '普通备注'],
        ['=1+1', '公式前缀'],
        ["'=1+1", '字面量保护前缀'],
      ],
    );

    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text).toContain('"鸡胸肉,原味"');
    expect(text).toContain('"带""引号""食物"');
    expect(text).toContain("'=1+1");
    expect(text.endsWith('\r\n')).toBe(true);
    expect(parseCsv(text)).toEqual({
      headers: ['名称', '备注'],
      rows: [
        { lineNumber: 2, values: ['鸡胸肉,原味', '第一行\n第二行“中文”'] },
        { lineNumber: 4, values: ['带"引号"食物', '普通备注'] },
        { lineNumber: 5, values: ["'=1+1", '公式前缀'] },
        { lineNumber: 6, values: ["''=1+1", '字面量保护前缀'] },
      ],
    });

    for (let apostropheCount = 0; apostropheCount <= 3; apostropheCount += 1) {
      const originalName = `${"'".repeat(apostropheCount)}=1+1`;
      const protectedLiteral = foodCsv([
        [
          originalName,
          '',
          '其他',
          0,
          0,
          0,
          0,
          null,
          '份',
          '否',
          '是',
          '否',
          '是',
          '',
          '',
          null,
          '',
          '否',
          '',
        ],
      ]);
      expect(parseFoodsCsv(protectedLiteral)[0].input.name).toBe(originalName);
    }
  });

  it('CSV 在解析阶段限制列数、记录数和单字段长度', () => {
    expect(() => parseCsv(`表头${','.repeat(64)}`)).toThrow(/最多允许 64 列/);
    expect(() => parseCsv('表头\n第一条\n第二条', { maxDataRows: 1 })).toThrow(/最多允许 1 条/);
    expect(() => parseCsv(`表头\n${'x'.repeat(11)}`, { maxFieldCharacters: 10 })).toThrow(
      /单个字段不能超过 10 个字符/,
    );
    expect(() =>
      parseBodyRecordsCsv(`\uFEFF${BODY_RECORD_CSV_HEADERS.join(',')}\r\n2026-08-01,,,,,多余列`),
    ).toThrow(/最多允许 5 列/);
  });

  it('身体 CSV 校验表头、日期和非负数，并正确还原多行备注', () => {
    const parsed = parseBodyRecordsCsv(
      bodyCsv([['2026-08-01', 69.8, 18.5, 78.2, '晨起,空腹\n复测']]),
    );
    expect(parsed).toEqual([
      {
        recordDate: '2026-08-01',
        weight: 69.8,
        bodyFatPercentage: 18.5,
        waistCircumference: 78.2,
        note: '晨起,空腹\n复测',
      },
    ]);

    expect(() => parseBodyRecordsCsv(serializeCsv(['日期'], [['2026-08-01']]))).toThrow(
      /CSV 表头不匹配/,
    );
    expect(() =>
      parseBodyRecordsCsv(bodyCsv([['2026-02-30', 69.8, null, null, '坏日期']])),
    ).toThrow(/第 2 行/);
    expect(() => parseBodyRecordsCsv(bodyCsv([['2026-08-01', -1, null, null, '负数']]))).toThrow(
      /第 2 行/,
    );
  });

  it('食物 CSV 校验分类、营养值和布尔字段', () => {
    const row = validFoodCsvRow('带,逗号的食物');
    row[18] = '一行\n二行"备注"';
    expect(parseFoodsCsv(foodCsv([row]))).toEqual([
      {
        input: expect.objectContaining({
          name: '带,逗号的食物',
          brand: '测试品牌',
          category: '其他',
          caloriesPer100g: 100,
          countInNutrition: true,
          note: '一行\n二行"备注"',
        }),
        isArchived: false,
      },
    ]);

    const negativeRow = validFoodCsvRow('负数食物');
    negativeRow[3] = -1;
    expect(() => parseFoodsCsv(foodCsv([negativeRow]))).toThrow(/第 2 行/);

    const invalidCategoryRow = validFoodCsvRow('分类错误食物');
    invalidCategoryRow[2] = '不存在分类';
    expect(() => parseFoodsCsv(foodCsv([invalidCategoryRow]))).toThrow(/食物分类/);

    const invalidBooleanRow = validFoodCsvRow('布尔错误食物');
    invalidBooleanRow[9] = '开启';
    expect(() => parseFoodsCsv(foodCsv([invalidBooleanRow]))).toThrow(/是否补剂/);

    const scheduledSupplementRow = validFoodCsvRow('CSV 计划补剂');
    scheduledSupplementRow[2] = '补剂';
    scheduledSupplementRow[9] = '是';
    scheduledSupplementRow[13] = '每周指定日';
    scheduledSupplementRow[14] = '周一、周三';
    scheduledSupplementRow[15] = 2;
    scheduledSupplementRow[16] = '份';
    expect(parseFoodsCsv(foodCsv([scheduledSupplementRow]))[0].input).toMatchObject({
      supplementFrequency: 'weekdays',
      supplementWeekdays: ['monday', 'wednesday'],
      supplementDosage: 2,
      supplementDosageUnit: 'serving',
    });

    const legacyHeaders = FOOD_CSV_HEADERS.filter(
      (header) =>
        !['补剂服用频率', '补剂服用星期', '补剂每次用量', '补剂用量单位'].includes(header),
    );
    const legacyRow = validFoodCsvRow('旧版 CSV 补剂').filter(
      (_, index) => index < 13 || index > 16,
    );
    legacyRow[2] = '补剂';
    legacyRow[9] = '是';
    expect(parseFoodsCsv(serializeCsv(legacyHeaders, [legacyRow]))[0].input).toMatchObject({
      supplementFrequency: 'as_needed',
      supplementWeekdays: [],
      supplementDosage: null,
      supplementDosageUnit: 'gram',
    });
  });

  it('从 CSV 文件导入身体数据时统计新增和更新，坏行不会产生部分写入', async () => {
    service.upsertBodyRecord({ recordDate: '2026-08-01', weight: 70 });
    const validPath = join(temporaryDirectory, 'body-valid.csv');
    writeFileSync(
      validPath,
      bodyCsv([
        ['2026-08-01', 69.8, 18.5, 78, '更新'],
        ['2026-08-02', 69.6, null, null, '新增'],
      ]),
      'utf8',
    );

    await expect(importCsvFromPath(service, validPath, 'body_records')).resolves.toEqual({
      createdCount: 1,
      updatedCount: 1,
    });

    const invalidPath = join(temporaryDirectory, 'body-invalid.csv');
    writeFileSync(
      invalidPath,
      bodyCsv([
        ['2026-08-03', 69.4, null, null, '本行也不能写入'],
        ['2026-08-04', -1, null, null, '错误行'],
      ]),
      'utf8',
    );
    await expect(importCsvFromPath(service, invalidPath, 'body_records')).rejects.toThrow(
      /第 3 行/,
    );
    expect(service.listBodyRecords().map((record) => record.recordDate)).not.toContain(
      '2026-08-03',
    );
  });

  it('从 CSV 文件导入食物，并在任一行无效时保持整批不写入', async () => {
    const validPath = join(temporaryDirectory, 'foods-valid.csv');
    const importedRow = validFoodCsvRow('文件导入食物');
    importedRow[11] = '是';
    importedRow[18] = '含,逗号备注';
    writeFileSync(validPath, foodCsv([importedRow]), 'utf8');

    await expect(importCsvFromPath(service, validPath, 'foods')).resolves.toEqual({
      createdCount: 1,
      updatedCount: 0,
    });
    expect(service.listFoods({ search: '文件导入食物' })).toEqual([
      expect.objectContaining({ isFavorite: true, note: '含,逗号备注' }),
    ]);

    const invalidPath = join(temporaryDirectory, 'foods-invalid.csv');
    const validRow = validFoodCsvRow('不应写入的第一行');
    const invalidRow = validFoodCsvRow('错误的第二行');
    invalidRow[6] = -5;
    writeFileSync(invalidPath, foodCsv([validRow, invalidRow]), 'utf8');

    await expect(importCsvFromPath(service, invalidPath, 'foods')).rejects.toThrow(/第 3 行/);
    expect(service.listFoods({ search: '不应写入的第一行' })).toEqual([]);
  });

  it('Excel 导出包含六个中文工作表、数值单元格、日期范围和历史快照', async () => {
    const originalFood = createFoodInput('历史导出食物', {
      brand: '旧品牌',
      category: '肉类',
      caloriesPer100g: 165,
      proteinPer100g: 31,
      carbsPer100g: 0,
      fatPer100g: 3.6,
    });
    const food = service.createFood(originalFood);
    service.upsertBodyRecord({ recordDate: '2026-08-02', weight: 69.8 });
    service.upsertBodyRecord({ recordDate: '2026-07-31', weight: 70.1 });
    service.createMealRecord({
      recordDate: '2026-08-02',
      mealType: 'dinner',
      foodId: food.id,
      amount: 100,
      unitType: 'gram',
      note: '历史明细',
    });
    service.createMealRecord({
      recordDate: '2026-07-31',
      mealType: 'dinner',
      foodId: food.id,
      amount: 50,
      unitType: 'gram',
    });
    service.updateFood(food.id, {
      ...originalFood,
      name: '食物库新名称',
      brand: '新品牌',
      caloriesPer100g: 100,
      proteinPer100g: 20,
    });
    service.createFoodCombination({
      name: '导出组合',
      items: [{ foodId: food.id, amount: 100, unitType: 'gram' }],
    });
    const activePlan = service.listDietPlans().find((plan) => plan.isActive);
    if (!activePlan) throw new Error('测试数据库缺少当前饮食方案');
    const dailyVariant = service.createDietPlanVariant({
      planId: activePlan.id,
      name: '导出日标签',
      targetCalories: 2_200,
      targetProtein: 150,
      targetCarbs: 275,
      targetFat: 56,
      note: '每日汇总标签',
    });
    service.setDailyPlanVariant({ recordDate: '2026-08-02', variantId: dailyVariant.id });

    const weightedPlan = service.createDietPlan({
      name: '体重系数导出方案',
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
      startDate: '2026-08-02',
    });
    service.createDietPlanVariant({
      planId: weightedPlan.id,
      name: '训练日导出标签',
      targetCalories: 2_300,
      targetProtein: 155,
      targetCarbs: 290,
      targetFat: 58,
      calculationMode: 'weight_based',
      weightSourceMode: 'manual',
      calculationWeight: 70,
      weightSourceDate: null,
      proteinPerKg: 2.2,
      carbsPerKg: 4,
      fatPerKg: 0.8,
      note: '标签导出备注',
    });

    const filePath = join(temporaryDirectory, 'export.xlsx');
    await expect(
      exportExcelToPath(service, filePath, {
        startDate: '2026-08-01',
        endDate: '2026-08-03',
      }),
    ).resolves.toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      '身体数据',
      '每日饮食明细',
      '每日营养汇总',
      '食物库',
      '饮食方案',
      '常用组合',
    ]);

    const bodySheet = workbook.getWorksheet('身体数据');
    expect(bodySheet?.getRow(1).values).toEqual([
      undefined,
      '日期',
      '体重(kg)',
      '体脂率(%)',
      '腰围(cm)',
      '备注',
    ]);
    expect(bodySheet?.rowCount).toBe(2);
    expect(bodySheet?.getCell('A2').value).toBe('2026-08-02');
    expect(typeof bodySheet?.getCell('B2').value).toBe('number');
    expect(bodySheet?.getCell('E2').value).toBeNull();

    const mealSheet = workbook.getWorksheet('每日饮食明细');
    expect(mealSheet?.rowCount).toBe(2);
    expect(mealSheet?.getCell('A2').value).toBe('2026-08-02');
    expect(mealSheet?.getCell('C2').value).toBe('历史导出食物');
    expect(mealSheet?.getCell('D2').value).toBe('旧品牌');
    expect(mealSheet?.getCell('I2').value).toBe(165);
    expect(typeof mealSheet?.getCell('H2').value).toBe('number');

    const summarySheet = workbook.getWorksheet('每日营养汇总');
    expect(summarySheet?.rowCount).toBe(2);
    expect(summarySheet?.getCell('A2').value).toBe('2026-08-02');
    expect(summarySheet?.getCell('B2').value).toBe(165);
    expect(summarySheet?.getCell('K2').value).toBe('导出日标签');

    const foodsSheet = workbook.getWorksheet('食物库');
    const foodNames = foodsSheet?.getColumn(1).values ?? [];
    expect(foodNames).toContain('食物库新名称');
    expect(foodNames).not.toContain('历史导出食物');

    const planSheet = workbook.getWorksheet('饮食方案');
    const weightedPlanRow = planSheet
      ?.getRows(2, planSheet.rowCount - 1)
      ?.find(
        (row) => row.getCell(1).value === '体重系数导出方案' && row.getCell(2).value === '基础目标',
      );
    const weightedVariantRow = planSheet
      ?.getRows(2, planSheet.rowCount - 1)
      ?.find(
        (row) =>
          row.getCell(1).value === '体重系数导出方案' && row.getCell(2).value === '训练日导出标签',
      );
    expect(planSheet?.getRow(1).values).toEqual([
      undefined,
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
    ]);
    expect(weightedPlanRow).toBeUndefined();
    expect(weightedVariantRow).toBeDefined();
    expect(weightedVariantRow?.getCell(4).value).toBe('按体重系数');
    expect(weightedVariantRow?.getCell(5).value).toBe('手动输入体重');
    expect(weightedVariantRow?.getCell(6).value).toBe(70);
    expect(weightedVariantRow?.getCell(8).value).toBe(2.2);
    expect(weightedVariantRow?.getCell(9).value).toBe(4);
    expect(weightedVariantRow?.getCell(10).value).toBe(0.8);
    expect(weightedVariantRow?.getCell(11).value).toBe(2_300);
    expect(weightedVariantRow?.getCell(12).value).toBe(155);
    expect(weightedVariantRow?.getCell(21).value).toBe('标签导出备注');
  });

  it('饮食方案和日型 IPC 都校验按体重模式的来源与系数', () => {
    const validPlan = {
      name: '系数校验方案',
      goalType: '减脂',
      targetCalories: 1800,
      targetProtein: 140,
      targetCarbs: 210,
      targetFat: 70,
      calculationMode: 'weight_based',
      weightSourceMode: 'latest',
      calculationWeight: 70,
      weightSourceDate: '2026-08-02',
      proteinPerKg: 2,
      carbsPerKg: 3,
      fatPerKg: 1,
      startDate: '2026-08-10',
    };
    expect(dietPlanInputSchema.safeParse(validPlan).success).toBe(true);
    expect(dietPlanInputSchema.safeParse({ ...validPlan, carbsPerKg: 21 }).success).toBe(false);
    expect(dietPlanInputSchema.safeParse({ ...validPlan, calculationWeight: 1001 }).success).toBe(
      false,
    );
    expect(dietPlanInputSchema.safeParse({ ...validPlan, weightSourceDate: null }).success).toBe(
      false,
    );
    expect(
      dietPlanInputSchema.safeParse({
        ...validPlan,
        weightSourceMode: 'manual',
        weightSourceDate: null,
      }).success,
    ).toBe(true);
    expect(
      dietPlanInputSchema.safeParse({
        ...validPlan,
        weightSourceMode: 'manual',
      }).success,
    ).toBe(false);
    expect(
      dietPlanInputSchema.safeParse({
        ...validPlan,
        calculationMode: undefined,
        calculationWeight: undefined,
        weightSourceDate: undefined,
        proteinPerKg: undefined,
        carbsPerKg: undefined,
        fatPerKg: undefined,
      }).success,
    ).toBe(true);

    const validVariant = {
      planId: 1,
      name: '训练日',
      targetCalories: 2_240,
      targetProtein: 154,
      targetCarbs: 280,
      targetFat: 56,
      calculationMode: 'weight_based',
      weightSourceMode: 'latest',
      calculationWeight: 70,
      weightSourceDate: '2026-08-02',
      proteinPerKg: 2.2,
      carbsPerKg: 4,
      fatPerKg: 0.8,
    };
    expect(dietPlanVariantInputSchema.safeParse(validVariant).success).toBe(true);
    expect(
      dietPlanVariantInputSchema.safeParse({ ...validVariant, proteinPerKg: 20.1 }).success,
    ).toBe(false);
    expect(
      dietPlanVariantInputSchema.safeParse({ ...validVariant, calculationWeight: null }).success,
    ).toBe(false);
    expect(
      dietPlanVariantInputSchema.safeParse({
        ...validVariant,
        weightSourceMode: 'manual',
        weightSourceDate: null,
      }).success,
    ).toBe(true);
  });

  it('CSV 明细导出带 BOM、应用日期范围并使用历史食物快照', async () => {
    const foodInput = createFoodInput('CSV 历史名称');
    const food = service.createFood(foodInput);
    service.createMealRecord({
      recordDate: '2026-08-02',
      mealType: 'breakfast',
      foodId: food.id,
      amount: 100,
      unitType: 'gram',
    });
    service.createMealRecord({
      recordDate: '2026-08-04',
      mealType: 'breakfast',
      foodId: food.id,
      amount: 100,
      unitType: 'gram',
    });
    service.updateFood(food.id, { ...foodInput, name: 'CSV 新名称' });

    const filePath = join(temporaryDirectory, 'meal-records.csv');
    await expect(
      exportCsvToPath(service, filePath, 'meal_records', {
        startDate: '2026-08-01',
        endDate: '2026-08-03',
      }),
    ).resolves.toBe(1);

    const content = readFileSync(filePath, 'utf8');
    expect(content.startsWith('\uFEFF')).toBe(true);
    const document = parseCsv(content);
    expect(document.rows).toHaveLength(1);
    expect(document.rows[0].values[0]).toBe('2026-08-02');
    expect(document.rows[0].values[2]).toBe('CSV 历史名称');
  });

  it('图表 CSV 仅导出当前派生列和行，并阻断公式注入', async () => {
    const filePath = join(temporaryDirectory, 'weight-chart.csv');
    await expect(
      saveChartCsvToPath(
        {
          suggestedName: '体重趋势',
          headers: ['日期', '体重(kg)', '7日平均(kg)', '备注'],
          rows: [
            ['2026-08-01', 70.1234, 70.1234, '晨起,空腹'],
            ['2026-08-02', 70, 70.0617, '=HYPERLINK("https://example.invalid")'],
          ],
        },
        filePath,
      ),
    ).resolves.toBe(2);

    const content = readFileSync(filePath, 'utf8');
    expect(content.startsWith('\uFEFF')).toBe(true);
    expect(parseCsv(content)).toEqual({
      headers: ['日期', '体重(kg)', '7日平均(kg)', '备注'],
      rows: [
        {
          lineNumber: 2,
          values: ['2026-08-01', '70.1234', '70.1234', '晨起,空腹'],
        },
        {
          lineNumber: 3,
          values: ['2026-08-02', '70', '70.0617', '\'=HYPERLINK("https://example.invalid")'],
        },
      ],
    });
  });

  it('图表 CSV 行列数非法时拒绝导出且不创建文件', async () => {
    const filePath = join(temporaryDirectory, 'invalid-chart.csv');
    await expect(
      saveChartCsvToPath(
        {
          suggestedName: '非法图表',
          headers: ['日期', '体重(kg)'],
          rows: [['2026-08-01']],
        },
        filePath,
      ),
    ).rejects.toThrow(/第 2 行列数与表头不一致/);
    expect(existsSync(filePath)).toBe(false);
  });

  it('图表 CSV 在构造完整字符串前拒绝超出字节预算的数据', async () => {
    const filePath = join(temporaryDirectory, 'oversized-chart.csv');
    const repeatedCell = '测'.repeat(64);
    await expect(
      saveChartCsvToPath(
        {
          suggestedName: '超大图表',
          headers: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
          rows: Array.from({ length: 10_000 }, () => Array(8).fill(repeatedCell)),
        },
        filePath,
      ),
    ).rejects.toThrow(/5 MB/);
    expect(existsSync(filePath)).toBe(false);
  });

  it('图表 CSV IPC 边界限制行数、列数和单元格长度', () => {
    expect(
      chartCsvExportInputSchema.safeParse({
        suggestedName: '越界列',
        headers: Array.from({ length: 9 }, (_, index) => `列${index}`),
        rows: [],
      }).success,
    ).toBe(false);
    expect(
      chartCsvExportInputSchema.safeParse({
        suggestedName: '越界行',
        headers: ['日期'],
        rows: Array.from({ length: 10_001 }, () => ['2026-08-10']),
      }).success,
    ).toBe(false);
    expect(
      chartCsvExportInputSchema.safeParse({
        suggestedName: '越界文本',
        headers: ['日期'],
        rows: [['x'.repeat(129)]],
      }).success,
    ).toBe(false);
    expect(
      chartCsvExportInputSchema.safeParse({
        suggestedName: '越界表头',
        headers: ['x'.repeat(129)],
        rows: [],
      }).success,
    ).toBe(false);
  });

  it('单独导出食物 CSV 时保留补剂计划且不会查询其他五类数据', async () => {
    const unexpectedQuery = (): never => {
      throw new Error('食物导出不应查询其他数据类型');
    };
    vi.spyOn(service, 'listBodyRecords').mockImplementation(unexpectedQuery);
    vi.spyOn(service, 'listMealRecordsForExport').mockImplementation(unexpectedQuery);
    vi.spyOn(service, 'listHistory').mockImplementation(unexpectedQuery);
    vi.spyOn(service, 'listDietPlans').mockImplementation(unexpectedQuery);
    vi.spyOn(service, 'listFoodCombinations').mockImplementation(unexpectedQuery);

    const supplement = service.createFood(
      createFoodInput('导出计划补剂', {
        category: '补剂',
        isSupplement: true,
        supplementFrequency: 'weekdays',
        supplementWeekdays: ['tuesday', 'friday'],
        supplementDosage: 1.5,
        supplementDosageUnit: 'serving',
      }),
    );

    const filePath = join(temporaryDirectory, 'foods-only.csv');
    await expect(exportCsvToPath(service, filePath, 'foods')).resolves.toBeGreaterThan(0);
    const content = readFileSync(filePath, 'utf8');
    expect(parseCsv(content).headers).toEqual([...FOOD_CSV_HEADERS]);
    expect(
      parseFoodsCsv(content).find((item) => item.input.name === supplement.name)?.input,
    ).toMatchObject({
      supplementFrequency: 'weekdays',
      supplementWeekdays: ['tuesday', 'friday'],
      supplementDosage: 1.5,
      supplementDosageUnit: 'serving',
    });
  });

  it('图表文件只接受有效 SVG 或 PNG 数据', async () => {
    const svgPath = join(temporaryDirectory, 'chart.svg');
    const svg =
      '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs><clipPath id="chart-clip"><rect width="10" height="10"/></clipPath></defs><g clip-path="url(#chart-clip)"><path d="M0 10L10 0" stroke="#0f766e"/><text x="1" y="9"><tspan>70.1</tspan></text></g></svg>';
    await expect(
      saveChartImageToPath({ format: 'svg', suggestedName: '趋势图', data: svg }, svgPath),
    ).resolves.toBeUndefined();
    expect(readFileSync(svgPath, 'utf8')).toBe(svg);

    const unsafePath = join(temporaryDirectory, 'unsafe.svg');
    for (const unsafeSvg of [
      '<svg><script>alert(1)</script></svg>',
      '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
      '<svg><image href="https://example.com/tracker.png"/></svg>',
      '<svg><g></svg>',
      '<svg><style>@import "https://example.com/style.css";</style></svg>',
      '<svg><rect style="fill:u&#114;l(h&#116;tps://example.invalid/x.svg#p)"/></svg>',
    ]) {
      await expect(
        saveChartImageToPath(
          { format: 'svg', suggestedName: '不安全图表', data: unsafeSvg },
          unsafePath,
        ),
      ).rejects.toThrow(/SVG/);
    }
    expect(existsSync(unsafePath)).toBe(false);

    const validPngData =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const pngPath = join(temporaryDirectory, 'chart.png');
    await expect(
      saveChartImageToPath(
        { format: 'png', suggestedName: '有效图片', data: validPngData },
        pngPath,
      ),
    ).resolves.toBeUndefined();
    expect(existsSync(pngPath)).toBe(true);

    await expect(
      saveChartImageToPath(
        { format: 'png', suggestedName: '错误图片', data: 'data:image/png;base64,AAAA' },
        join(temporaryDirectory, 'bad.png'),
      ),
    ).rejects.toThrow(/PNG 文件签名无效/);
    await expect(
      saveChartImageToPath(
        {
          format: 'png',
          suggestedName: '截断图片',
          data: 'data:image/png;base64,iVBORw0KGgo=',
        },
        join(temporaryDirectory, 'truncated.png'),
      ),
    ).rejects.toThrow(/PNG 文件结构|PNG 数据块不完整/);

    const corruptedPng = Buffer.from(validPngData.split(',')[1], 'base64');
    corruptedPng[45] ^= 0x01;
    await expect(
      saveChartImageToPath(
        {
          format: 'png',
          suggestedName: '校验失败图片',
          data: `data:image/png;base64,${corruptedPng.toString('base64')}`,
        },
        join(temporaryDirectory, 'corrupted.png'),
      ),
    ).rejects.toThrow(/PNG 数据块校验失败/);

    await expect(
      saveChartImageToPath(
        {
          format: 'png',
          suggestedName: '空图像数据',
          data: createPngDataUrl(Buffer.alloc(0)),
        },
        join(temporaryDirectory, 'empty-idat.png'),
      ),
    ).rejects.toThrow(/IDAT 图像数据为空/);
    await expect(
      saveChartImageToPath(
        {
          format: 'png',
          suggestedName: '无效过滤器',
          data: createPngDataUrl(deflateSync(Buffer.from([5, 0, 0, 0, 0]))),
        },
        join(temporaryDirectory, 'invalid-filter.png'),
      ),
    ).rejects.toThrow(/PNG 扫描线过滤器无效/);
  });
});
