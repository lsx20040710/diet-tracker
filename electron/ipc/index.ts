import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { ZodError, type ZodType } from 'zod';

import type { ApiResult } from '../../src/types/models';
import type { DatabaseService } from '../database';
import { AppError, normalizeDatabaseError } from '../errors';
import { FileOperationService } from '../file-operation-service';
import { IPC_CHANNELS } from './channels';
import {
  addCombinationToMealInputSchema,
  bodyRecordInputSchema,
  chartCsvExportInputSchema,
  chartImageExportInputSchema,
  clearMealSchema,
  copyMealsInputSchema,
  dateSchema,
  dateRangeQuerySchema,
  dietPlanInputSchema,
  dietPlanVariantInputSchema,
  duplicateDietPlanPayloadSchema,
  foodCombinationInputSchema,
  foodInputSchema,
  foodQuerySchema,
  historyQuerySchema,
  idSchema,
  importCsvKindSchema,
  mealRecordInputSchema,
  mealRecordUpdateSchema,
  reorderMealSchema,
  setDailyPlanVariantInputSchema,
  setMealIndulgenceInputSchema,
  setFoodFavoritePayloadSchema,
  exportCsvPayloadSchema,
  updateDietPlanPayloadSchema,
  updateDietPlanVariantPayloadSchema,
  updateFoodCombinationPayloadSchema,
  updateFoodPayloadSchema,
} from './schemas';

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function toApiResult<T>(operation: () => T): ApiResult<T> {
  try {
    return { ok: true, data: operation() };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        error: error.issues[0]?.message ?? '提交的数据格式无效。',
      };
    }

    const safeError = error instanceof AppError ? error : normalizeDatabaseError(error);
    console.error(`[IPC:${safeError.code}]`, error);
    return { ok: false, code: safeError.code, error: safeError.message };
  }
}

async function toApiResultAsync<T>(operation: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        error: error.issues[0]?.message ?? '提交的数据格式无效。',
      };
    }

    const safeError =
      error instanceof AppError
        ? error
        : new AppError('FILE_OPERATION_FAILED', '文件操作失败，请重试。', { cause: error });
    console.error(`[IPC:${safeError.code}]`, error);
    return { ok: false, code: safeError.code, error: safeError.message };
  }
}

function register(channel: string, handler: (...args: unknown[]) => unknown): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args));
}

function registerAsync(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, handler);
}

/** 注册渲染进程可调用的最小 IPC 白名单。 */
export function registerIpcHandlers(database: DatabaseService): void {
  const fileOperations = new FileOperationService(database);
  register(IPC_CHANNELS.getAppInfo, () => toApiResult(() => database.getAppInfo()));
  register(IPC_CHANNELS.getDashboard, (date) =>
    toApiResult(() => database.getDashboard(parse(dateSchema, date))),
  );
  register(IPC_CHANNELS.listBodyRecords, () => toApiResult(() => database.listBodyRecords()));
  register(IPC_CHANNELS.upsertBodyRecord, (input) =>
    toApiResult(() => database.upsertBodyRecord(parse(bodyRecordInputSchema, input))),
  );
  register(IPC_CHANNELS.deleteBodyRecord, (id) =>
    toApiResult(() => database.deleteBodyRecord(parse(idSchema, id))),
  );
  register(IPC_CHANNELS.listFoods, (query) =>
    toApiResult(() => database.listFoods(parse(foodQuerySchema, query))),
  );
  register(IPC_CHANNELS.createFood, (input) =>
    toApiResult(() => database.createFood(parse(foodInputSchema, input))),
  );
  register(IPC_CHANNELS.updateFood, (payload) =>
    toApiResult(() => {
      const parsed = parse(updateFoodPayloadSchema, payload);
      return database.updateFood(parsed.id, parsed.input);
    }),
  );
  register(IPC_CHANNELS.setFoodFavorite, (payload) =>
    toApiResult(() => {
      const parsed = parse(setFoodFavoritePayloadSchema, payload);
      return database.setFoodFavorite(parsed.id, parsed.isFavorite);
    }),
  );
  register(IPC_CHANNELS.archiveFood, (id) =>
    toApiResult(() => database.archiveFood(parse(idSchema, id))),
  );
  register(IPC_CHANNELS.createMealRecord, (input) =>
    toApiResult(() => database.createMealRecord(parse(mealRecordInputSchema, input))),
  );
  register(IPC_CHANNELS.updateMealRecord, (input) =>
    toApiResult(() => database.updateMealRecord(parse(mealRecordUpdateSchema, input))),
  );
  register(IPC_CHANNELS.deleteMealRecord, (id) =>
    toApiResult(() => database.deleteMealRecord(parse(idSchema, id))),
  );
  register(IPC_CHANNELS.clearMeal, (payload) =>
    toApiResult(() => {
      const parsed = parse(clearMealSchema, payload);
      return database.clearMeal(parsed.date, parsed.mealType);
    }),
  );
  register(IPC_CHANNELS.reorderMeal, (recordIds) =>
    toApiResult(() => database.reorderMeal(parse(reorderMealSchema, recordIds))),
  );
  register(IPC_CHANNELS.setMealIndulgence, (input) =>
    toApiResult(() => database.setMealIndulgence(parse(setMealIndulgenceInputSchema, input))),
  );
  register(IPC_CHANNELS.listDietPlans, () => toApiResult(() => database.listDietPlans()));
  register(IPC_CHANNELS.createDietPlan, (input) =>
    toApiResult(() => database.createDietPlan(parse(dietPlanInputSchema, input))),
  );
  register(IPC_CHANNELS.updateDietPlan, (payload) =>
    toApiResult(() => {
      const parsed = parse(updateDietPlanPayloadSchema, payload);
      return database.updateDietPlan(parsed.id, parsed.input);
    }),
  );
  register(IPC_CHANNELS.duplicateDietPlan, (payload) =>
    toApiResult(() => {
      const parsed = parse(duplicateDietPlanPayloadSchema, payload);
      return database.duplicateDietPlan(parsed.id, parsed.input);
    }),
  );
  register(IPC_CHANNELS.activateDietPlan, (id) =>
    toApiResult(() => database.activateDietPlan(parse(idSchema, id))),
  );
  register(IPC_CHANNELS.deleteDietPlan, (id) =>
    toApiResult(() => database.deleteDietPlan(parse(idSchema, id))),
  );
  register(IPC_CHANNELS.listDietPlanVariants, (planId) =>
    toApiResult(() => database.listDietPlanVariants(parse(idSchema, planId))),
  );
  register(IPC_CHANNELS.createDietPlanVariant, (input) =>
    toApiResult(() => database.createDietPlanVariant(parse(dietPlanVariantInputSchema, input))),
  );
  register(IPC_CHANNELS.updateDietPlanVariant, (payload) =>
    toApiResult(() => {
      const parsed = parse(updateDietPlanVariantPayloadSchema, payload);
      return database.updateDietPlanVariant(parsed.id, parsed.input);
    }),
  );
  register(IPC_CHANNELS.deleteDietPlanVariant, (id) =>
    toApiResult(() => database.deleteDietPlanVariant(parse(idSchema, id))),
  );
  register(IPC_CHANNELS.setDailyPlanVariant, (input) =>
    toApiResult(() => database.setDailyPlanVariant(parse(setDailyPlanVariantInputSchema, input))),
  );
  register(IPC_CHANNELS.clearDailyPlanVariant, (recordDate) =>
    toApiResult(() => database.clearDailyPlanVariant(parse(dateSchema, recordDate))),
  );
  register(IPC_CHANNELS.listFoodCombinations, () =>
    toApiResult(() => database.listFoodCombinations()),
  );
  register(IPC_CHANNELS.createFoodCombination, (input) =>
    toApiResult(() => database.createFoodCombination(parse(foodCombinationInputSchema, input))),
  );
  register(IPC_CHANNELS.updateFoodCombination, (payload) =>
    toApiResult(() => {
      const parsed = parse(updateFoodCombinationPayloadSchema, payload);
      return database.updateFoodCombination(parsed.id, parsed.input);
    }),
  );
  register(IPC_CHANNELS.deleteFoodCombination, (id) =>
    toApiResult(() => database.deleteFoodCombination(parse(idSchema, id))),
  );
  register(IPC_CHANNELS.addCombinationToMeal, (input) =>
    toApiResult(() => database.addCombinationToMeal(parse(addCombinationToMealInputSchema, input))),
  );
  register(IPC_CHANNELS.copyMeals, (input) =>
    toApiResult(() => database.copyMeals(parse(copyMealsInputSchema, input))),
  );
  register(IPC_CHANNELS.listHistory, (query) =>
    toApiResult(() => database.listHistory(parse(historyQuerySchema, query))),
  );
  register(IPC_CHANNELS.getHistoryDay, (date) =>
    toApiResult(() => database.getHistoryDay(parse(dateSchema, date))),
  );
  register(IPC_CHANNELS.getTrendData, (query) =>
    toApiResult(() => database.getTrendData(parse(dateRangeQuerySchema, query))),
  );
  registerAsync(IPC_CHANNELS.exportExcel, (event, query) =>
    toApiResultAsync(() =>
      fileOperations.exportExcel(
        BrowserWindow.fromWebContents(event.sender),
        parse(dateRangeQuerySchema, query ?? {}),
      ),
    ),
  );
  registerAsync(IPC_CHANNELS.exportCsv, (event, payload) =>
    toApiResultAsync(() => {
      const parsed = parse(exportCsvPayloadSchema, payload);
      return fileOperations.exportCsv(
        BrowserWindow.fromWebContents(event.sender),
        parsed.kind,
        parsed.query ?? {},
      );
    }),
  );
  registerAsync(IPC_CHANNELS.importCsv, (event, kind) =>
    toApiResultAsync(() =>
      fileOperations.importCsv(
        BrowserWindow.fromWebContents(event.sender),
        parse(importCsvKindSchema, kind),
      ),
    ),
  );
  registerAsync(IPC_CHANNELS.exportChartCsv, (event, input) =>
    toApiResultAsync(() =>
      fileOperations.exportChartCsv(
        BrowserWindow.fromWebContents(event.sender),
        parse(chartCsvExportInputSchema, input),
      ),
    ),
  );
  registerAsync(IPC_CHANNELS.exportChartImage, (event, input) =>
    toApiResultAsync(() =>
      fileOperations.exportChartImage(
        BrowserWindow.fromWebContents(event.sender),
        parse(chartImageExportInputSchema, input),
      ),
    ),
  );
}

export function removeIpcHandlers(): void {
  Object.values(IPC_CHANNELS).forEach((channel) => ipcMain.removeHandler(channel));
}
