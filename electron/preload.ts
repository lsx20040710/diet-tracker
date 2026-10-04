import { contextBridge, ipcRenderer } from 'electron';

import type { DietTrackerApi } from '../src/types/models';
import { IPC_CHANNELS } from './ipc/channels';

/** 只暴露业务方法，不向页面提供任意 IPC、Node.js 或文件系统访问能力。 */
const dietTrackerApi: DietTrackerApi = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getAppInfo),
  getStorageInfo: () => ipcRenderer.invoke(IPC_CHANNELS.getStorageInfo),
  chooseStorageDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseStorageDirectory),
  changeStorageDirectory: (input) => ipcRenderer.invoke(IPC_CHANNELS.changeStorageDirectory, input),
  getDashboard: (date) => ipcRenderer.invoke(IPC_CHANNELS.getDashboard, date),
  listBodyRecords: () => ipcRenderer.invoke(IPC_CHANNELS.listBodyRecords),
  upsertBodyRecord: (input) => ipcRenderer.invoke(IPC_CHANNELS.upsertBodyRecord, input),
  deleteBodyRecord: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteBodyRecord, id),
  listFoods: (query) => ipcRenderer.invoke(IPC_CHANNELS.listFoods, query),
  createFood: (input) => ipcRenderer.invoke(IPC_CHANNELS.createFood, input),
  updateFood: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.updateFood, { id, input }),
  setFoodFavorite: (id, isFavorite) =>
    ipcRenderer.invoke(IPC_CHANNELS.setFoodFavorite, { id, isFavorite }),
  archiveFood: (id) => ipcRenderer.invoke(IPC_CHANNELS.archiveFood, id),
  createMealRecord: (input) => ipcRenderer.invoke(IPC_CHANNELS.createMealRecord, input),
  updateMealRecord: (input) => ipcRenderer.invoke(IPC_CHANNELS.updateMealRecord, input),
  deleteMealRecord: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteMealRecord, id),
  clearMeal: (date, mealType) => ipcRenderer.invoke(IPC_CHANNELS.clearMeal, { date, mealType }),
  reorderMeal: (recordIds) => ipcRenderer.invoke(IPC_CHANNELS.reorderMeal, recordIds),
  setMealIndulgence: (input) => ipcRenderer.invoke(IPC_CHANNELS.setMealIndulgence, input),
  listDietPlans: () => ipcRenderer.invoke(IPC_CHANNELS.listDietPlans),
  createDietPlan: (input) => ipcRenderer.invoke(IPC_CHANNELS.createDietPlan, input),
  updateDietPlan: (id, input) => ipcRenderer.invoke(IPC_CHANNELS.updateDietPlan, { id, input }),
  duplicateDietPlan: (id, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.duplicateDietPlan, { id, input }),
  activateDietPlan: (id) => ipcRenderer.invoke(IPC_CHANNELS.activateDietPlan, id),
  deleteDietPlan: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteDietPlan, id),
  listDietPlanVariants: (planId) => ipcRenderer.invoke(IPC_CHANNELS.listDietPlanVariants, planId),
  createDietPlanVariant: (input) => ipcRenderer.invoke(IPC_CHANNELS.createDietPlanVariant, input),
  updateDietPlanVariant: (id, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateDietPlanVariant, { id, input }),
  deleteDietPlanVariant: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteDietPlanVariant, id),
  setDailyPlanVariant: (input) => ipcRenderer.invoke(IPC_CHANNELS.setDailyPlanVariant, input),
  clearDailyPlanVariant: (recordDate) =>
    ipcRenderer.invoke(IPC_CHANNELS.clearDailyPlanVariant, recordDate),
  listFoodCombinations: () => ipcRenderer.invoke(IPC_CHANNELS.listFoodCombinations),
  createFoodCombination: (input) => ipcRenderer.invoke(IPC_CHANNELS.createFoodCombination, input),
  updateFoodCombination: (id, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateFoodCombination, { id, input }),
  deleteFoodCombination: (id) => ipcRenderer.invoke(IPC_CHANNELS.deleteFoodCombination, id),
  addCombinationToMeal: (input) => ipcRenderer.invoke(IPC_CHANNELS.addCombinationToMeal, input),
  copyMeals: (input) => ipcRenderer.invoke(IPC_CHANNELS.copyMeals, input),
  listHistory: (query) => ipcRenderer.invoke(IPC_CHANNELS.listHistory, query),
  getHistoryDay: (date) => ipcRenderer.invoke(IPC_CHANNELS.getHistoryDay, date),
  getTrendData: (query) => ipcRenderer.invoke(IPC_CHANNELS.getTrendData, query),
  exportExcel: (query) => ipcRenderer.invoke(IPC_CHANNELS.exportExcel, query),
  exportCsv: (kind, query) => ipcRenderer.invoke(IPC_CHANNELS.exportCsv, { kind, query }),
  importCsv: (kind) => ipcRenderer.invoke(IPC_CHANNELS.importCsv, kind),
  exportChartCsv: (input) => ipcRenderer.invoke(IPC_CHANNELS.exportChartCsv, input),
  exportChartImage: (input) => ipcRenderer.invoke(IPC_CHANNELS.exportChartImage, input),
};

contextBridge.exposeInMainWorld('dietTracker', Object.freeze(dietTrackerApi));
