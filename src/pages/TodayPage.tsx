import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';

import { BodyQuickCard } from '../components/BodyQuickCard';
import { CopyMealsDialog } from '../components/CopyMealsDialog';
import { DailyPlanVariantSelector } from '../components/DailyPlanVariantSelector';
import { REGULAR_MEAL_TYPES } from '../components/meal-labels';
import { MealSection } from '../components/MealSection';
import { EditMealRecordDialog } from '../components/MealRecordDialog';
import { NutritionCard } from '../components/NutritionCard';
import { SupplementSection } from '../components/SupplementSection';
import { useAppStore } from '../stores/app-store';
import type { MealRecord, MealType } from '../types/models';
import { formatChineseDate, shiftDate, todayString } from '../utils/date';

interface TodayPageProps {
  onAddFood: (mealType: MealType) => void;
}

export function TodayPage({ onAddFood }: TodayPageProps) {
  const selectedDate = useAppStore((state) => state.selectedDate);
  const dashboard = useAppStore((state) => state.dashboard);
  const loading = useAppStore((state) => state.dashboardLoading);
  const dashboardStale = useAppStore((state) => state.dashboardStale);
  const setDate = useAppStore((state) => state.setDate);
  const shiftSelectedDate = useAppStore((state) => state.shiftSelectedDate);
  const returnToday = useAppStore((state) => state.returnToday);
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const [editingRecord, setEditingRecord] = useState<MealRecord | null>(null);
  const [copyingMealType, setCopyingMealType] = useState<MealType | 'all' | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const dashboardMatchesDate = dashboard?.date === selectedDate;

  if (loading && !dashboardMatchesDate) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        正在读取本地数据…
      </div>
    );
  }

  if (!dashboard || !dashboardMatchesDate) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-sm text-slate-600">
        <p>今日数据暂时无法显示。</p>
        <button
          className="mt-3 font-medium text-emerald-700"
          onClick={() => void loadDashboard()}
          type="button"
        >
          重新加载
        </button>
      </div>
    );
  }

  const { consumed, target } = dashboard.nutrition;

  return (
    <div className="mx-auto max-w-[1680px] space-y-4 p-5">
      <section className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            aria-label="前一天"
            className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-50"
            onClick={() => void shiftSelectedDate(-1)}
            type="button"
          >
            <ChevronLeft className="size-4" />
          </button>
          <label className="relative">
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              aria-label="选择记录日期"
              className="rounded-lg border border-slate-300 py-2 pl-10 pr-3 text-sm font-medium text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15"
              onChange={(event) => {
                if (event.target.value) void setDate(event.target.value);
              }}
              required
              type="date"
              value={selectedDate}
            />
          </label>
          <button
            aria-label="后一天"
            className="rounded-lg border border-slate-300 p-2 text-slate-600 hover:bg-slate-50"
            onClick={() => void shiftSelectedDate(1)}
            type="button"
          >
            <ChevronRight className="size-4" />
          </button>
          {selectedDate !== todayString() ? (
            <button
              className="rounded-lg px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
              onClick={() => void returnToday()}
              type="button"
            >
              返回今天
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => {
              setCopyFeedback(null);
              setCopyingMealType('all');
            }}
            title="把前一天的指定餐次复制到当前日期"
            type="button"
          >
            <Copy className="size-4" />
            复制前一天记录
          </button>
          <p className="text-sm text-slate-500">{formatChineseDate(selectedDate)}</p>
          <button
            aria-label="刷新当前日期数据"
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            onClick={() => void loadDashboard()}
            title="刷新"
            type="button"
          >
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </section>

      {dashboardStale ? (
        <div
          className="flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          role="alert"
        >
          <span>记录已经保存，但当前页面未刷新；重新加载前已暂停当日编辑，避免重复记录。</span>
          <button
            className="shrink-0 font-medium text-amber-900 underline"
            onClick={() => void loadDashboard()}
            type="button"
          >
            重新加载
          </button>
        </div>
      ) : null}

      <fieldset className="contents" disabled={dashboardStale}>
        <DailyPlanVariantSelector />

        {copyFeedback ? (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <CheckCircle2 className="size-4" />
            {copyFeedback}
          </div>
        ) : null}

        {!dashboard.activePlan && !dashboard.dailyPlan ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            尚未设置当前饮食方案，营养目标按 0 显示。请在“饮食方案”中创建并启用方案。
          </div>
        ) : !dashboard.activePlan && dashboard.dailyPlan ? (
          <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
            当前没有启用中的饮食方案；本页仍按该日期已保存的目标快照显示。
          </div>
        ) : null}

        <div className="grid grid-cols-1 items-start gap-4 min-[1280px]:grid-cols-[minmax(0,1fr)_320px]">
          <main className="order-2 min-w-0 space-y-4 min-[1280px]:order-1">
            {REGULAR_MEAL_TYPES.map((mealType) => (
              <MealSection
                allocation={mealType === 'snack' ? null : dashboard.mealAllocation.meals[mealType]}
                key={mealType}
                mealType={mealType}
                onAdd={onAddFood}
                onCopyPrevious={(value) => {
                  setCopyFeedback(null);
                  setCopyingMealType(value);
                }}
                onEdit={setEditingRecord}
                records={dashboard.meals[mealType]}
                snackDeductedFrom={dashboard.mealAllocation.snack.deductedFrom}
              />
            ))}
            <SupplementSection
              completionRecords={Object.values(dashboard.meals).flat()}
              onAdd={() => onAddFood('supplement')}
              onEdit={setEditingRecord}
              recommendations={dashboard.supplementRecommendations}
              records={dashboard.meals.supplement}
            />
          </main>

          <aside className="order-1 space-y-4 min-[1280px]:sticky min-[1280px]:top-0 min-[1280px]:order-2">
            <BodyQuickCard record={dashboard.bodyRecord} />
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-semibold text-slate-900">当日营养概览</h2>
                <span className="text-xs text-slate-500">实时汇总</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <NutritionCard
                  colorClassName="bg-orange-500"
                  consumed={consumed.calories}
                  digits={1}
                  label="热量"
                  target={target.calories}
                  unit="kcal"
                />
                <NutritionCard
                  colorClassName="bg-emerald-500"
                  consumed={consumed.protein}
                  label="蛋白质"
                  target={target.protein}
                  unit="g"
                />
                <NutritionCard
                  colorClassName="bg-sky-500"
                  consumed={consumed.carbs}
                  label="碳水"
                  target={target.carbs}
                  unit="g"
                />
                <NutritionCard
                  colorClassName="bg-violet-500"
                  consumed={consumed.fat}
                  label="脂肪"
                  target={target.fat}
                  unit="g"
                />
              </div>
            </section>
            <section className="rounded-xl border border-sky-200 bg-sky-50/70 p-4">
              <div className="flex items-center gap-2 text-sky-800">
                <Sparkles className="size-4" />
                <h2 className="text-sm font-semibold">摄入量推荐已启用</h2>
              </div>
              <p className="mt-2 text-xs leading-5 text-sky-700">
                食物种类由你选择。进入“填写食用数量”后点击“推荐摄入量”，系统按该餐剩余目标自动填数；保存为推荐量的记录会随本餐后续食物动态调整。
              </p>
              <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs font-medium text-sky-800">
                当前早中晚比例：{dashboard.mealAllocation.mealRatios.breakfast} :{' '}
                {dashboard.mealAllocation.mealRatios.lunch} :{' '}
                {dashboard.mealAllocation.mealRatios.dinner}
              </p>
            </section>
          </aside>
        </div>

        <EditMealRecordDialog onClose={() => setEditingRecord(null)} record={editingRecord} />
        <CopyMealsDialog
          fixedMealType={copyingMealType && copyingMealType !== 'all' ? copyingMealType : undefined}
          initialTargetDate={selectedDate}
          onClose={() => setCopyingMealType(null)}
          onCopied={(count) => setCopyFeedback(`已从前一天复制 ${count} 条记录。`)}
          open={copyingMealType !== null}
          sourceDate={shiftDate(selectedDate, -1)}
          title={copyingMealType === 'all' ? '复制前一天记录' : undefined}
        />
      </fieldset>
    </div>
  );
}
