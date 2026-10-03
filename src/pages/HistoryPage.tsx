import { CheckCircle2, Copy, Eye, FilterX, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CopyMealsDialog } from '../components/CopyMealsDialog';
import { mealLabels } from '../components/meal-labels';
import {
  primaryButtonClass,
  secondaryButtonClass,
  SelectInput,
} from '../components/ui/FormControls';
import { Modal } from '../components/ui/Modal';
import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { formatMealAmount } from '../utils/meal-amount';
import type {
  DietPlan,
  GoalFilter,
  HistoryDayDetail,
  HistoryDaySummary,
  HistoryQuery,
  MealType,
} from '../types/models';
import { formatChineseDate, todayString } from '../utils/date';
import { formatNutrition, sumNutrition } from '../utils/nutrition';

const mealOrder: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack', 'supplement'];

interface HistoricalPlanOption {
  id: number;
  name: string;
}

function GoalBadge({ met }: { met: boolean | null }) {
  if (met === null) return <span className="text-slate-400">无目标</span>;
  return (
    <span
      className={`rounded-full px-2 py-1 text-xs ${
        met ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
      }`}
    >
      {met ? '已达到' : '未达到'}
    </span>
  );
}

function formatPlanSnapshot(planName: string | null, variantName: string | null): string {
  if (!planName) return '无方案';
  return variantName ? `${planName} · ${variantName}` : planName;
}

/** 按日读取真实饮食快照，并提供筛选、明细和跨日期复制入口。 */
export function HistoryPage() {
  const [rows, setRows] = useState<HistoryDaySummary[]>([]);
  const [plans, setPlans] = useState<DietPlan[]>([]);
  const [historicalPlans, setHistoricalPlans] = useState<HistoricalPlanOption[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [planId, setPlanId] = useState('');
  const [calorieStatus, setCalorieStatus] = useState<GoalFilter>('all');
  const [proteinStatus, setProteinStatus] = useState<GoalFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryDayDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [copySourceDate, setCopySourceDate] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const historyRequestId = useRef(0);
  const detailRequestId = useRef(0);

  const planOptions = useMemo(() => {
    const options = new Map<number, { id: number; name: string; isDeleted: boolean }>();
    for (const plan of historicalPlans) options.set(plan.id, { ...plan, isDeleted: true });
    for (const plan of plans) {
      options.set(plan.id, { id: plan.id, name: plan.name, isDeleted: false });
    }
    return [...options.values()].sort((left, right) =>
      left.name.localeCompare(right.name, 'zh-CN'),
    );
  }, [historicalPlans, plans]);

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequestId.current;
    if (startDate && endDate && startDate > endDate) {
      setRows([]);
      setError('开始日期不能晚于结束日期');
      setLoading(false);
      return;
    }
    const query: HistoryQuery = {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      planId: planId ? Number(planId) : undefined,
      calorieStatus,
      proteinStatus,
    };
    setLoading(true);
    setError(null);
    try {
      const result = unwrapApiResult(await getDietTrackerApi().listHistory(query));
      if (requestId !== historyRequestId.current) return;
      setRows(result);
      // 快照中的方案即使已从方案库删除，也必须继续作为历史筛选项保留。
      setHistoricalPlans((current) => {
        const discovered = new Map(current.map((plan) => [plan.id, plan]));
        for (const row of result) {
          if (row.planId !== null && row.planName && !discovered.has(row.planId)) {
            discovered.set(row.planId, { id: row.planId, name: row.planName });
          }
        }
        return [...discovered.values()];
      });
    } catch (loadError) {
      if (requestId === historyRequestId.current) setError(getErrorMessage(loadError));
    } finally {
      if (requestId === historyRequestId.current) setLoading(false);
    }
  }, [calorieStatus, endDate, planId, proteinStatus, startDate]);

  useEffect(() => {
    let cancelled = false;
    void getDietTrackerApi()
      .listDietPlans()
      .then((result) => {
        if (!cancelled) setPlans(unwrapApiResult(result));
      })
      .catch((loadError) => {
        if (!cancelled) setError(getErrorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadHistory(), 100);
    return () => window.clearTimeout(timer);
  }, [loadHistory]);

  async function openDetail(recordDate: string) {
    const requestId = ++detailRequestId.current;
    setDetailLoading(true);
    setDetail(null);
    setError(null);
    try {
      const result = unwrapApiResult(await getDietTrackerApi().getHistoryDay(recordDate));
      if (requestId === detailRequestId.current) setDetail(result);
    } catch (loadError) {
      if (requestId === detailRequestId.current) setError(getErrorMessage(loadError));
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  }

  function resetFilters() {
    setStartDate('');
    setEndDate('');
    setPlanId('');
    setCalorieStatus('all');
    setProteinStatus('all');
  }

  return (
    <div className="mx-auto flex h-full max-w-[1680px] flex-col p-5">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">历史记录</h1>
          <p className="mt-1 text-sm text-slate-500">
            按日查看身体、饮食与补剂快照，并复制指定记录。
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1.5 text-sm text-slate-600 shadow-sm">
          {rows.length} 天
        </span>
      </div>

      {feedback ? (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="size-4" />
          {feedback}
        </div>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-2 items-end gap-3 border-b border-slate-200 p-4 xl:grid-cols-3 2xl:grid-cols-[repeat(2,minmax(135px,1fr))_minmax(160px,1fr)_repeat(2,minmax(145px,1fr))_auto]">
          <label className="text-xs font-medium text-slate-600">
            开始日期
            <input
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
              onChange={(event) => setStartDate(event.target.value)}
              type="date"
              value={startDate}
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            结束日期
            <input
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
              onChange={(event) => setEndDate(event.target.value)}
              type="date"
              value={endDate}
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            饮食方案
            <SelectInput
              className="mt-1.5"
              onChange={(event) => setPlanId(event.target.value)}
              value={planId}
            >
              <option value="">全部方案</option>
              {planOptions.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                  {plan.isDeleted ? '（历史方案，已删除）' : ''}
                </option>
              ))}
            </SelectInput>
          </label>
          <label className="text-xs font-medium text-slate-600">
            热量目标
            <SelectInput
              className="mt-1.5"
              onChange={(event) => setCalorieStatus(event.target.value as GoalFilter)}
              value={calorieStatus}
            >
              <option value="all">全部</option>
              <option value="met">已达到</option>
              <option value="not_met">未达到</option>
            </SelectInput>
          </label>
          <label className="text-xs font-medium text-slate-600">
            蛋白质目标
            <SelectInput
              className="mt-1.5"
              onChange={(event) => setProteinStatus(event.target.value as GoalFilter)}
              value={proteinStatus}
            >
              <option value="all">全部</option>
              <option value="met">已达到</option>
              <option value="not_met">未达到</option>
            </SelectInput>
          </label>
          <button className={secondaryButtonClass} onClick={resetFilters} type="button">
            <FilterX className="size-4" />
            清空筛选
          </button>
        </div>

        {error ? (
          <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
            <button
              className="ml-3 font-medium underline"
              onClick={() => void loadHistory()}
              type="button"
            >
              重试
            </button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[1180px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs font-medium text-slate-500 shadow-[0_1px_0_#e2e8f0]">
              <tr>
                <th className="px-4 py-3">日期</th>
                <th className="px-3 py-3 text-right">体重</th>
                <th className="px-3 py-3 text-right">体脂率</th>
                <th className="px-3 py-3 text-right">腰围</th>
                <th className="px-3 py-3 text-right">热量</th>
                <th className="px-3 py-3 text-right">蛋白质</th>
                <th className="px-3 py-3 text-right">碳水</th>
                <th className="px-3 py-3 text-right">脂肪</th>
                <th className="px-3 py-3">方案</th>
                <th className="px-3 py-3">热量目标</th>
                <th className="px-3 py-3">蛋白目标</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr className="hover:bg-slate-50" key={row.recordDate}>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <button
                      className="text-left hover:text-emerald-700 hover:underline"
                      onClick={() => void openDetail(row.recordDate)}
                      title="查看当天饮食与补剂详情"
                      type="button"
                    >
                      {formatChineseDate(row.recordDate)}
                    </button>
                  </td>
                  <td className="px-3 py-3 text-right text-slate-700">
                    {row.weight === null ? '—' : `${formatNutrition(row.weight, 2)} kg`}
                  </td>
                  <td className="px-3 py-3 text-right text-slate-700">
                    {row.bodyFatPercentage === null
                      ? '—'
                      : `${formatNutrition(row.bodyFatPercentage, 1)}%`}
                  </td>
                  <td className="px-3 py-3 text-right text-slate-700">
                    {row.waistCircumference === null
                      ? '—'
                      : `${formatNutrition(row.waistCircumference, 1)} cm`}
                  </td>
                  <td className="px-3 py-3 text-right text-slate-700">
                    {formatNutrition(row.nutrition.calories, 1)} kcal
                  </td>
                  <td className="px-3 py-3 text-right text-slate-700">
                    {formatNutrition(row.nutrition.protein, 1)}g
                  </td>
                  <td className="px-3 py-3 text-right text-slate-700">
                    {formatNutrition(row.nutrition.carbs, 1)}g
                  </td>
                  <td className="px-3 py-3 text-right text-slate-700">
                    {formatNutrition(row.nutrition.fat, 1)}g
                  </td>
                  <td
                    className="max-w-40 truncate px-3 py-3 text-slate-600"
                    title={formatPlanSnapshot(row.planName, row.variantName)}
                  >
                    {formatPlanSnapshot(row.planName, row.variantName)}
                  </td>
                  <td className="px-3 py-3">
                    <GoalBadge met={row.meetsCalories} />
                  </td>
                  <td className="px-3 py-3">
                    <GoalBadge met={row.meetsProtein} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        aria-label={`查看 ${row.recordDate} 详情`}
                        className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        onClick={() => void openDetail(row.recordDate)}
                        title="查看详情"
                        type="button"
                      >
                        <Eye className="size-4" />
                      </button>
                      <button
                        aria-label={`复制 ${row.recordDate} 饮食`}
                        className="rounded-md p-2 text-slate-400 hover:bg-emerald-50 hover:text-emerald-700"
                        disabled={row.mealCount === 0}
                        onClick={() => {
                          setFeedback(null);
                          setCopySourceDate(row.recordDate);
                        }}
                        title="复制到今天或指定日期"
                        type="button"
                      >
                        <Copy className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading ? (
            <div className="flex h-56 items-center justify-center gap-2 text-sm text-slate-500">
              <LoaderCircle className="size-4 animate-spin" />
              正在读取历史记录…
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-56 items-center justify-center text-sm text-slate-500">
              当前筛选范围内没有历史记录
            </div>
          ) : null}
        </div>
      </section>

      <Modal
        description={detail ? formatChineseDate(detail.summary.recordDate) : undefined}
        onClose={() => setDetail(null)}
        open={Boolean(detail)}
        title="当日饮食与补剂详情"
        widthClassName="max-w-4xl"
      >
        {detail ? (
          <div className="space-y-4">
            <p className="rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              当日饮食目标：
              {formatPlanSnapshot(detail.summary.planName, detail.summary.variantName)}
            </p>
            <div className="grid grid-cols-4 gap-3 rounded-xl bg-slate-50 p-4 text-sm">
              {[
                ['热量', detail.summary.nutrition.calories, 'kcal'],
                ['蛋白质', detail.summary.nutrition.protein, 'g'],
                ['碳水', detail.summary.nutrition.carbs, 'g'],
                ['脂肪', detail.summary.nutrition.fat, 'g'],
              ].map(([label, value, unit]) => (
                <div key={String(label)}>
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className="mt-1 font-semibold text-slate-900">
                    {formatNutrition(Number(value), 1)} {unit}
                  </p>
                </div>
              ))}
            </div>
            {mealOrder.map((mealType) => {
              const records = detail.meals[mealType];
              const total = sumNutrition(
                records
                  .filter((record) => record.countInNutritionSnapshot)
                  .map(({ calories, protein, carbs, fat }) => ({ calories, protein, carbs, fat })),
              );
              return (
                <section
                  className="overflow-hidden rounded-xl border border-slate-200"
                  key={mealType}
                >
                  <header className="flex items-center justify-between bg-slate-50 px-4 py-2.5">
                    <h3 className="text-sm font-semibold text-slate-900">{mealLabels[mealType]}</h3>
                    <span className="text-xs text-slate-500">
                      {records.length} 项 · {formatNutrition(total.calories, 1)} kcal
                    </span>
                  </header>
                  {records.length ? (
                    <div className="divide-y divide-slate-100">
                      {records.map((record) => (
                        <div
                          className="grid grid-cols-[minmax(160px,1fr)_90px_repeat(4,76px)] gap-2 px-4 py-2.5 text-sm"
                          key={record.id}
                        >
                          <span className="truncate font-medium text-slate-800">
                            {record.foodNameSnapshot}
                          </span>
                          <span className="text-right text-slate-600">
                            {formatMealAmount(record.amount, record.unitType)}
                            {record.unitType === 'gram' ? 'g' : record.unitNameSnapshot}
                          </span>
                          <span className="text-right text-slate-600">
                            {formatNutrition(record.calories, 1)} kcal
                          </span>
                          <span className="text-right text-slate-600">
                            {formatNutrition(record.protein, 1)}g
                          </span>
                          <span className="text-right text-slate-600">
                            {formatNutrition(record.carbs, 1)}g
                          </span>
                          <span className="text-right text-slate-600">
                            {formatNutrition(record.fat, 1)}g
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="px-4 py-3 text-sm text-slate-400">未记录</p>
                  )}
                </section>
              );
            })}
            <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button
                className={secondaryButtonClass}
                onClick={() => setDetail(null)}
                type="button"
              >
                关闭
              </button>
              <button
                className={primaryButtonClass}
                onClick={() => {
                  const sourceDate = detail.summary.recordDate;
                  setDetail(null);
                  setFeedback(null);
                  setCopySourceDate(sourceDate);
                }}
                type="button"
              >
                <Copy className="size-4" />
                复制这一天
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      {detailLoading ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/15">
          <span className="rounded-lg bg-white px-4 py-3 text-sm text-slate-600 shadow-lg">
            正在读取当日详情…
          </span>
        </div>
      ) : null}

      <CopyMealsDialog
        initialTargetDate={todayString()}
        onClose={() => setCopySourceDate(null)}
        onCopied={async (count, targetDate) => {
          setFeedback(`已复制 ${count} 条饮食与补剂记录到 ${targetDate}。`);
          await loadHistory();
        }}
        open={copySourceDate !== null}
        sourceDate={copySourceDate ?? todayString()}
      />
    </div>
  );
}
