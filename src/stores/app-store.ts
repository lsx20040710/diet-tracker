import { create } from 'zustand';

import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import type {
  BodyRecordInput,
  CoreMealType,
  DashboardData,
  MealRecordInput,
  MealRecordUpdate,
  MealType,
} from '../types/models';
import { isValidDateString, shiftDate, todayString } from '../utils/date';

export type PageId =
  | 'today'
  | 'body'
  | 'trends'
  | 'plans'
  | 'foods'
  | 'supplements'
  | 'history'
  | 'transfer'
  | 'settings';

export type SaveStatus = 'saved' | 'saving' | 'error';

interface AppState {
  currentPage: PageId;
  selectedDate: string;
  dashboard: DashboardData | null;
  dashboardLoading: boolean;
  dashboardStale: boolean;
  saveStatus: SaveStatus;
  errorMessage: string | null;
  setPage: (page: PageId) => void;
  setDate: (date: string) => Promise<void>;
  shiftSelectedDate: (days: number) => Promise<void>;
  returnToday: () => Promise<void>;
  loadDashboard: (date?: string) => Promise<boolean>;
  saveBodyRecord: (input: BodyRecordInput) => Promise<void>;
  createMealRecord: (input: MealRecordInput) => Promise<void>;
  updateMealRecord: (input: MealRecordUpdate) => Promise<void>;
  deleteMealRecord: (id: number) => Promise<void>;
  clearMeal: (mealType: MealType) => Promise<void>;
  reorderMeal: (recordIds: number[]) => Promise<void>;
  setMealIndulgence: (mealType: CoreMealType, enabled: boolean) => Promise<void>;
  selectDailyPlanVariant: (variantId: number | null) => Promise<void>;
  beginSaving: () => void;
  finishSaving: () => void;
  reportSaveError: (message: string) => void;
  clearError: () => void;
}

let dashboardRequestId = 0;

export const useAppStore = create<AppState>((set, get) => {
  async function reloadAfterWrite(): Promise<void> {
    const loaded = await get().loadDashboard(get().selectedDate);
    if (loaded) {
      set({ saveStatus: 'saved' });
      return;
    }
    // 写入结果与视图刷新结果分开呈现，避免用户因“保存失败”误判而重复提交。
    set((state) => ({
      saveStatus: 'saved',
      dashboardStale: true,
      errorMessage: state.errorMessage ?? '记录已保存，但页面刷新失败，请点击刷新重试。',
    }));
  }

  async function runWrite(operation: () => Promise<void>): Promise<void> {
    set({ saveStatus: 'saving', errorMessage: null });
    try {
      await operation();
      await reloadAfterWrite();
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      set({ saveStatus: 'error', errorMessage });
      throw error;
    }
  }

  return {
    currentPage: 'today',
    selectedDate: todayString(),
    dashboard: null,
    dashboardLoading: false,
    dashboardStale: false,
    saveStatus: 'saved',
    errorMessage: null,
    setPage: (currentPage) => set({ currentPage }),
    setDate: async (selectedDate) => {
      if (!isValidDateString(selectedDate)) {
        set({ errorMessage: '日期无效，请重新选择。' });
        return;
      }
      const previousDate = get().selectedDate;
      const previousDashboard = get().dashboard;
      const previousDashboardStale = get().dashboardStale;
      set({ selectedDate });
      const loaded = await get().loadDashboard(selectedDate);
      if (!loaded && get().selectedDate === selectedDate) {
        // 快速连续切换时回到最后一份真实已加载数据，不能留下“新日期 + 旧内容”。
        set({
          selectedDate: previousDashboard?.date ?? previousDate,
          dashboard: previousDashboard,
          dashboardLoading: false,
          dashboardStale: previousDashboardStale,
        });
      }
    },
    shiftSelectedDate: async (days) => {
      await get().setDate(shiftDate(get().selectedDate, days));
    },
    returnToday: async () => {
      await get().setDate(todayString());
    },
    loadDashboard: async (date) => {
      const requestedDate = date ?? get().selectedDate;
      const requestId = ++dashboardRequestId;
      set({ dashboardLoading: true, errorMessage: null });
      try {
        const dashboard = unwrapApiResult(await getDietTrackerApi().getDashboard(requestedDate));
        if (requestId === dashboardRequestId && get().selectedDate === requestedDate) {
          set({ dashboard, dashboardLoading: false, dashboardStale: false });
          return true;
        }
        // 更新的请求已接管同一状态时不属于加载失败，调用方不能因此回滚用户日期。
        return true;
      } catch (error) {
        if (requestId === dashboardRequestId) {
          set({
            dashboardLoading: false,
            dashboardStale: true,
            errorMessage: getErrorMessage(error),
          });
        }
        return false;
      }
    },
    saveBodyRecord: async (input) => {
      await runWrite(async () => {
        unwrapApiResult(await getDietTrackerApi().upsertBodyRecord(input));
      });
    },
    createMealRecord: async (input) => {
      await runWrite(async () => {
        unwrapApiResult(await getDietTrackerApi().createMealRecord(input));
      });
    },
    updateMealRecord: async (input) => {
      await runWrite(async () => {
        unwrapApiResult(await getDietTrackerApi().updateMealRecord(input));
      });
    },
    deleteMealRecord: async (id) => {
      await runWrite(async () => {
        unwrapApiResult(await getDietTrackerApi().deleteMealRecord(id));
      });
    },
    clearMeal: async (mealType) => {
      await runWrite(async () => {
        unwrapApiResult(await getDietTrackerApi().clearMeal(get().selectedDate, mealType));
      });
    },
    reorderMeal: async (recordIds) => {
      await runWrite(async () => {
        unwrapApiResult(await getDietTrackerApi().reorderMeal(recordIds));
      });
    },
    setMealIndulgence: async (mealType, enabled) => {
      await runWrite(async () => {
        unwrapApiResult(
          await getDietTrackerApi().setMealIndulgence({
            recordDate: get().selectedDate,
            mealType,
            enabled,
          }),
        );
      });
    },
    selectDailyPlanVariant: async (variantId) => {
      await runWrite(async () => {
        const recordDate = get().selectedDate;
        if (variantId === null) {
          unwrapApiResult(await getDietTrackerApi().clearDailyPlanVariant(recordDate));
          return;
        }
        unwrapApiResult(await getDietTrackerApi().setDailyPlanVariant({ recordDate, variantId }));
      });
    },
    beginSaving: () => set({ saveStatus: 'saving', errorMessage: null }),
    finishSaving: () => set({ saveStatus: 'saved' }),
    reportSaveError: (errorMessage) => set({ saveStatus: 'error', errorMessage }),
    clearError: () => set({ errorMessage: null }),
  };
});
