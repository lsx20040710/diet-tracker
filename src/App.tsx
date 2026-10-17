import { AlertCircle, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';

import { AddMealRecordDialog } from './components/MealRecordDialog';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import {
  Field,
  primaryButtonClass,
  secondaryButtonClass,
  TextInput,
} from './components/ui/FormControls';
import { Modal } from './components/ui/Modal';
import { ConfirmationDialog } from './components/ui/ConfirmationDialog';
import { BodyDataPage } from './pages/BodyDataPage';
import { DietPlansPage } from './pages/DietPlansPage';
import { FoodsPage } from './pages/FoodsPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { SupplementsPage } from './pages/SupplementsPage';
import { TodayPage } from './pages/TodayPage';
import { TransferPage } from './pages/TransferPage';
import { getErrorMessage } from './services/api';
import { useAppStore } from './stores/app-store';
import { useSettingsStore } from './stores/settings-store';
import type { MealType } from './types/models';

const TrendsPage = lazy(() =>
  import('./pages/TrendsPage').then((module) => ({ default: module.TrendsPage })),
);

function defaultMealType(): MealType {
  const hour = new Date().getHours();
  if (hour < 10) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snack';
}

interface QuickWeightDialogProps {
  open: boolean;
  onClose: () => void;
}

function QuickWeightDialog({ open, onClose }: QuickWeightDialogProps) {
  const selectedDate = useAppStore((state) => state.selectedDate);
  const dashboard = useAppStore((state) => state.dashboard);
  const bodyRecord = dashboard?.date === selectedDate ? dashboard.bodyRecord : null;
  const saveBodyRecord = useAppStore((state) => state.saveBodyRecord);
  const [weight, setWeight] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setWeight(
      bodyRecord?.weight === null || bodyRecord?.weight === undefined
        ? ''
        : String(bodyRecord.weight),
    );
    setError(null);
  }, [bodyRecord, open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsedWeight = Number(weight);
    if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
      setError('体重必须是大于 0 的数字');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await saveBodyRecord({
        recordDate: selectedDate,
        weight: parsedWeight,
        bodyFatPercentage: bodyRecord?.bodyFatPercentage ?? null,
        waistCircumference: bodyRecord?.waistCircumference ?? null,
        note: bodyRecord?.note ?? '',
      });
      onClose();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      description={`记录日期：${selectedDate}`}
      onClose={onClose}
      open={open}
      title="快速记录体重"
      widthClassName="max-w-sm"
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <Field label="体重 (kg)">
          <TextInput
            autoFocus
            min="0.01"
            onChange={(event) => setWeight(event.target.value)}
            placeholder="例如 65.5"
            required
            step="0.01"
            type="number"
            value={weight}
          />
        </Field>
        {error ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        ) : null}
        <div className="flex justify-end gap-3 border-t border-slate-200 pt-5">
          <button className={secondaryButtonClass} onClick={onClose} type="button">
            取消
          </button>
          <button className={primaryButtonClass} disabled={submitting} type="submit">
            {submitting ? '正在保存…' : '保存体重'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function App() {
  const loadSettings = useSettingsStore((state) => state.loadSettings);
  const currentPage = useAppStore((state) => state.currentPage);
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const selectedDate = useAppStore((state) => state.selectedDate);
  const dashboard = useAppStore((state) => state.dashboard);
  const dashboardLoading = useAppStore((state) => state.dashboardLoading);
  const dashboardStale = useAppStore((state) => state.dashboardStale);
  const errorMessage = useAppStore((state) => state.errorMessage);
  const clearError = useAppStore((state) => state.clearError);
  const [quickWeightOpen, setQuickWeightOpen] = useState(false);
  const [addFoodOpen, setAddFoodOpen] = useState(false);
  const [addMealType, setAddMealType] = useState<MealType>(defaultMealType());
  const dashboardReady = dashboard?.date === selectedDate && !dashboardLoading && !dashboardStale;

  const openFoodDialog = useCallback(
    (mealType: MealType = defaultMealType()) => {
      if (!dashboardReady) return;
      setAddMealType(mealType);
      setAddFoodOpen(true);
    },
    [dashboardReady],
  );

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (quickWeightOpen || addFoodOpen) return;
      // 任一业务弹窗打开时由弹窗处理键盘，避免快捷键叠加第二层弹窗。
      if (document.querySelector('[role="dialog"]')) return;
      const key = event.key.toLocaleLowerCase();
      if (key === 'e') {
        event.preventDefault();
        useAppStore.getState().setPage('transfer');
        return;
      }
      if (!dashboardReady) return;
      if (key === 'n') {
        event.preventDefault();
        openFoodDialog();
      } else if (key === 'w') {
        event.preventDefault();
        setQuickWeightOpen(true);
      } else if (key === 'f' && currentPage === 'today') {
        event.preventDefault();
        openFoodDialog();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [addFoodOpen, currentPage, dashboardReady, openFoodDialog, quickWeightOpen]);

  let page;
  switch (currentPage) {
    case 'body':
      page = <BodyDataPage />;
      break;
    case 'plans':
      page = <DietPlansPage />;
      break;
    case 'foods':
      page = <FoodsPage />;
      break;
    case 'supplements':
      page = <SupplementsPage />;
      break;
    case 'history':
      page = <HistoryPage />;
      break;
    case 'trends':
      page = <TrendsPage />;
      break;
    case 'transfer':
      page = <TransferPage />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    case 'today':
    default:
      page = <TodayPage onAddFood={openFoodDialog} />;
      break;
  }

  return (
    <div className="flex h-screen min-h-[680px] min-w-[1024px] overflow-hidden bg-slate-100 text-slate-900">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onQuickFood={() => openFoodDialog()}
          onQuickWeight={() => {
            if (dashboardReady) setQuickWeightOpen(true);
          }}
          quickActionsDisabled={!dashboardReady}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          <Suspense
            fallback={
              <p className="p-6 text-sm text-slate-500" role="status">
                正在加载页面…
              </p>
            }
          >
            {page}
          </Suspense>
        </div>
      </div>

      {errorMessage ? (
        <div className="fixed bottom-5 right-5 z-40 flex max-w-md items-start gap-3 rounded-xl border border-red-200 bg-white p-4 text-sm text-red-700 shadow-xl">
          <AlertCircle className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">操作未完成</p>
            <p className="mt-1 break-words text-red-600">{errorMessage}</p>
          </div>
          <button
            aria-label="关闭错误提示"
            className="rounded p-1 hover:bg-red-50"
            onClick={clearError}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}

      <QuickWeightDialog onClose={() => setQuickWeightOpen(false)} open={quickWeightOpen} />
      <AddMealRecordDialog
        initialMealType={addMealType}
        onClose={() => setAddFoodOpen(false)}
        open={addFoodOpen}
      />
      <ConfirmationDialog />
    </div>
  );
}
