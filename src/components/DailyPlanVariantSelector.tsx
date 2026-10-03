import { CalendarCheck2, LoaderCircle, Tag } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { useAppStore } from '../stores/app-store';
import type { DietPlanVariant, NutritionTarget } from '../types/models';
import { formatNutrition } from '../utils/nutrition';
import { SelectInput } from './ui/FormControls';

const HISTORICAL_SNAPSHOT_VALUE = '__historical_snapshot__';
const NO_DAY_PLANS_VALUE = '__no_day_plans__';

function hasSameTarget(left: NutritionTarget, right: NutritionTarget): boolean {
  return (
    left.calories === right.calories &&
    left.protein === right.protein &&
    left.carbs === right.carbs &&
    left.fat === right.fat
  );
}

/** 在同一饮食方案内切换当前日期的日型，并保留历史目标快照。 */
export function DailyPlanVariantSelector() {
  const selectedDate = useAppStore((state) => state.selectedDate);
  const dashboard = useAppStore((state) => state.dashboard);
  const selectDailyPlanVariant = useAppStore((state) => state.selectDailyPlanVariant);
  const [variants, setVariants] = useState<DietPlanVariant[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const pendingRef = useRef(false);

  const activePlan = dashboard?.activePlan ?? null;
  const activePlanId = activePlan?.id ?? null;
  const dailyPlan = dashboard?.dailyPlan ?? null;

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setVariants([]);
    setError(null);
    if (activePlanId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void getDietTrackerApi()
      .listDietPlanVariants(activePlanId)
      .then((result) => {
        if (requestId === requestIdRef.current) setVariants(unwrapApiResult(result));
      })
      .catch((loadError) => {
        if (requestId === requestIdRef.current) setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [activePlanId]);

  if (!dashboard) return null;

  const dailyPlanMatchesActive = Boolean(activePlan && dailyPlan?.planId === activePlan.id);
  const dailyPlanMatchesCurrentPlanName = Boolean(
    dailyPlanMatchesActive && activePlan && dailyPlan?.planName === activePlan.name,
  );
  const primaryVariant = variants[0] ?? null;
  const selectedVariant =
    dailyPlan?.variantId === null || dailyPlan?.variantId === undefined
      ? null
      : (variants.find((variant) => variant.id === dailyPlan.variantId) ?? null);
  const representsCurrentVariant = Boolean(
    dailyPlan &&
    dailyPlanMatchesCurrentPlanName &&
    selectedVariant &&
    dailyPlan.variantName === selectedVariant.name &&
    hasSameTarget(dailyPlan.target, selectedVariant),
  );
  const selectValue =
    !activePlan || variants.length === 0
      ? NO_DAY_PLANS_VALUE
      : !dailyPlan && primaryVariant
        ? String(primaryVariant.id)
        : representsCurrentVariant && selectedVariant
          ? String(selectedVariant.id)
          : HISTORICAL_SNAPSHOT_VALUE;
  const effectivePlanName = dailyPlan?.planName || activePlan?.name || '尚未设置';
  const effectiveVariantName =
    dailyPlan?.variantName ??
    (!dailyPlan && primaryVariant
      ? primaryVariant.name
      : variants.length > 0
        ? '未指定日型'
        : '基础目标');
  const deletedVariantSnapshot = Boolean(
    dailyPlan?.variantName !== null && dailyPlan?.variantId === null,
  );
  const snapshotStatus = deletedVariantSnapshot
    ? '日型已删除，保留快照'
    : dailyPlanMatchesActive
      ? dailyPlan?.variantName === null
        ? '未指定日型的旧快照'
        : '日型旧快照'
      : '历史快照';
  const target = dashboard.nutrition.target;

  async function handleSelection(value: string): Promise<void> {
    if (pendingRef.current || value === HISTORICAL_SNAPSHOT_VALUE || value === NO_DAY_PLANS_VALUE) {
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await selectDailyPlanVariant(Number(value));
    } catch (selectionError) {
      setError(getErrorMessage(selectionError));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <section className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-[260px] flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
            <CalendarCheck2 className="size-4" />
            {selectedDate} 的日型计划
          </div>
          <p className="mt-1 text-xs text-emerald-800/75">
            当前：{effectivePlanName} · {effectiveVariantName}
            。切换只改变同一方案在这一天采用的目标。
            {deletedVariantSnapshot ? ' 原日型已删除，这一天仍保留当时的目标。' : ''}
          </p>
        </div>
        <label className="w-full text-sm font-medium text-slate-700 sm:w-[300px]">
          <span className="sr-only">选择当天日型计划</span>
          <div className="relative">
            {loading || pending ? (
              <LoaderCircle className="pointer-events-none absolute right-9 top-1/2 z-10 size-4 -translate-y-1/2 animate-spin text-slate-400" />
            ) : (
              <Tag className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-emerald-600" />
            )}
            <SelectInput
              aria-label="选择当天日型计划"
              className="mt-0 pl-9"
              disabled={!activePlan || variants.length === 0 || loading || pending}
              onChange={(event) => void handleSelection(event.target.value)}
              value={selectValue}
            >
              {!activePlan ? (
                <option value={NO_DAY_PLANS_VALUE}>尚未设置当前饮食方案</option>
              ) : null}
              {activePlan && variants.length === 0 ? (
                <option value={NO_DAY_PLANS_VALUE}>请先为当前方案添加日型计划</option>
              ) : null}
              {variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.name}
                </option>
              ))}
              {selectValue === HISTORICAL_SNAPSHOT_VALUE && dailyPlan ? (
                <option value={HISTORICAL_SNAPSHOT_VALUE}>
                  {dailyPlan.variantName ?? '未指定日型'}（{snapshotStatus}）
                </option>
              ) : null}
            </SelectInput>
          </div>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
        {[
          ['热量', target.calories, 'kcal'],
          ['蛋白质', target.protein, 'g'],
          ['碳水', target.carbs, 'g'],
          ['脂肪', target.fat, 'g'],
        ].map(([label, value, unit]) => (
          <span className="rounded-full bg-white px-2.5 py-1 shadow-sm" key={String(label)}>
            {label} {formatNutrition(Number(value), 1)} {unit}
          </span>
        ))}
      </div>
      {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}
    </section>
  );
}
