import { create } from 'zustand';

import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import type { AppSettings } from '../types/models';

interface SettingsState {
  settings: AppSettings | null;
  loading: boolean;
  saving: boolean;
  errorMessage: string | null;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: false,
  saving: false,
  errorMessage: null,
  loadSettings: async () => {
    if (get().loading || get().saving) return;
    set({ loading: true, errorMessage: null });
    try {
      const settings = unwrapApiResult(await getDietTrackerApi().getAppSettings());
      set({ settings });
    } catch (error) {
      set({ errorMessage: getErrorMessage(error) });
    } finally {
      set({ loading: false });
    }
  },
  saveSettings: async (input) => {
    set({ saving: true, errorMessage: null });
    try {
      const settings = unwrapApiResult(await getDietTrackerApi().saveAppSettings(input));
      set({ settings });
    } catch (error) {
      set({ errorMessage: getErrorMessage(error) });
    } finally {
      set({ saving: false });
    }
  },
}));
