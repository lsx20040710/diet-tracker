import type { DietTrackerApi } from './models';

declare global {
  interface Window {
    dietTracker: DietTrackerApi;
  }
}

export {};
