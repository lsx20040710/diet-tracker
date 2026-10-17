import { Copy, GripVertical, PartyPopper, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { getErrorMessage } from '../services/api';
import { confirmAction } from '../stores/confirmation-store';
import { useAppStore } from '../stores/app-store';
import {
  CORE_MEAL_TYPES,
  type CoreMealAllocation,
  type CoreMealType,
  type MealRecord,
} from '../types/models';
import { NUTRITION_METRIC_LABELS } from '../utils/meal-allocation';
import { formatMealAmount } from '../utils/meal-amount';
import { formatNutrition, sumNutrition } from '../utils/nutrition';
import { mealLabels, type RegularMealType } from './meal-labels';

interface MealSectionProps {
  mealType: RegularMealType;
  records: MealRecord[];
  allocation: CoreMealAllocation | null;
  snackDeductedFrom: CoreMealType;
  onAdd: (mealType: RegularMealType) => void;
  onEdit: (record: MealRecord) => void;
  onCopyPrevious: (mealType: RegularMealType) => void;
}

export function MealSection({
  mealType,
  records,
  allocation,
  snackDeductedFrom,
  onAdd,
  onEdit,
  onCopyPrevious,
}: MealSectionProps) {
  const deleteMealRecord = useAppStore((state) => state.deleteMealRecord);
  const clearMeal = useAppStore((state) => state.clearMeal);
  const reorderMeal = useAppStore((state) => state.reorderMeal);
  const setMealIndulgence = useAppStore((state) => state.setMealIndulgence);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const isCoreMeal = CORE_MEAL_TYPES.includes(mealType as CoreMealType);
  const isIndulgence = allocation?.isIndulgence === true;

  const total = useMemo(
    () =>
      sumNutrition(
        records
          .filter((record) => record.countInNutritionSnapshot)
          .map(({ calories, protein, carbs, fat }) => ({ calories, protein, carbs, fat })),
      ),
    [records],
  );

  const vegetableGrams = useMemo(
    () =>
      records
        .filter((record) => record.categorySnapshot === '蔬菜')
        .reduce((sum, record) => sum + record.gramsSnapshot, 0),
    [records],
  );

  async function handleDelete(record: MealRecord) {
    if (pendingRef.current) return;
    if (!(await confirmAction(`确定删除“${record.foodNameSnapshot}”这条记录吗？`))) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await deleteMealRecord(record.id);
    } catch (deleteError) {
      setError(getErrorMessage(deleteError));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function handleClear() {
    if (pendingRef.current) return;
    if (records.length === 0) return;
    if (
      !(await confirmAction(`确定清空${mealLabels[mealType]}的全部 ${records.length} 条记录吗？`))
    )
      return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await clearMeal(mealType);
    } catch (clearError) {
      setError(getErrorMessage(clearError));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function handleIndulgence() {
    if (pendingRef.current || !isCoreMeal) return;
    if (
      !isIndulgence &&
      records.length > 0 &&
      !(await confirmAction(
        `设为放纵餐后会清除${mealLabels[mealType]}现有的 ${records.length} 条食物记录，并按本餐目标直接记满。是否继续？`,
      ))
    ) {
      return;
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await setMealIndulgence(mealType as CoreMealType, !isIndulgence);
    } catch (indulgenceError) {
      setError(getErrorMessage(indulgenceError));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function handleDrop(targetId: number) {
    if (pendingRef.current || draggedId === null || draggedId === targetId) return;
    const orderedIds = records.map((record) => record.id);
    const sourceIndex = orderedIds.indexOf(draggedId);
    const targetIndex = orderedIds.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    orderedIds.splice(sourceIndex, 1);
    orderedIds.splice(targetIndex, 0, draggedId);
    setDraggedId(null);
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await reorderMeal(orderedIds);
    } catch (reorderError) {
      setError(getErrorMessage(reorderError));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-900">{mealLabels[mealType]}</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {records.length} 项 · {formatNutrition(total.calories, 1)} kcal · 蛋白质{' '}
            {formatNutrition(total.protein, 1)}g
          </p>
          {allocation ? (
            <p className="mt-1 text-xs leading-5 text-sky-700">
              动态目标 {formatNutrition(allocation.target.calories, 1)} kcal · 蛋白质{' '}
              {formatNutrition(allocation.target.protein, 1)}g · 碳水{' '}
              {formatNutrition(allocation.target.carbs, 1)}g · 脂肪{' '}
              {formatNutrition(allocation.target.fat, 1)}g
            </p>
          ) : records.length > 0 ? (
            <p className="mt-1 text-xs text-sky-700">
              加餐营养从{mealLabels[snackDeductedFrom]}额度扣除
            </p>
          ) : null}
          {(mealType === 'lunch' || mealType === 'dinner') && (
            <p
              className={`mt-1 text-xs font-medium ${
                vegetableGrams >= 200 ? 'text-emerald-600' : 'text-amber-600'
              }`}
            >
              {vegetableGrams >= 200
                ? `🥦 蔬菜已达标 (${Math.round(vegetableGrams)}g)`
                : `🥦 建议补充蔬菜至 200-300g (当前: ${Math.round(vegetableGrams)}g)`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isCoreMeal ? (
            <button
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                isIndulgence
                  ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                  : 'text-amber-700 hover:bg-amber-100'
              }`}
              disabled={pending}
              onClick={() => void handleIndulgence()}
              type="button"
            >
              <PartyPopper className="size-3.5" />
              {isIndulgence ? '取消放纵餐' : '放纵餐'}
            </button>
          ) : null}
          {!isIndulgence ? (
            <>
              <button
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-200 hover:text-slate-900"
                disabled={pending}
                onClick={() => onCopyPrevious(mealType)}
                title={`把昨天${mealLabels[mealType]}复制到当前日期`}
                type="button"
              >
                <Copy className="size-3.5" />
                复制昨日同餐
              </button>
              <button
                className="whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-200 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={pending || records.length === 0}
                onClick={handleClear}
                type="button"
              >
                清空
              </button>
              <button
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700"
                disabled={pending}
                onClick={() => onAdd(mealType)}
                type="button"
              >
                <Plus className="size-3.5" />
                添加食物
              </button>
            </>
          ) : null}
        </div>
      </header>

      {isIndulgence && allocation ? (
        <div className="border-b border-amber-100 bg-amber-50 px-5 py-6">
          <div className="flex items-center gap-2 text-amber-900">
            <PartyPopper className="size-5" />
            <p className="font-semibold">本餐已设为放纵餐</p>
          </div>
          <p className="mt-2 text-sm leading-6 text-amber-800">
            不记录具体食物，热量和三大营养素已按当前动态目标直接记满；前餐超额或加餐扣减时会同步调整。
          </p>
        </div>
      ) : records.length === 0 ? (
        <button
          className="flex w-full flex-col items-center justify-center px-4 py-8 text-sm text-slate-400 transition hover:bg-slate-50 hover:text-emerald-700"
          disabled={pending}
          onClick={() => onAdd(mealType)}
          type="button"
        >
          <Plus className="mb-1 size-5" />
          尚未记录，点击添加食物
        </button>
      ) : (
        <div className="divide-y divide-slate-100 overflow-x-auto">
          {records.map((record) => (
            <div
              className={`grid min-w-[590px] grid-cols-[24px_minmax(110px,1.4fr)_74px_repeat(4,62px)_66px] items-center gap-2 px-3 py-3 text-sm transition ${
                draggedId === record.id ? 'bg-emerald-50 opacity-60' : 'hover:bg-slate-50'
              }`}
              draggable={!pending}
              key={record.id}
              onDragEnd={() => setDraggedId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDragStart={(event) => {
                setDraggedId(record.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(record.id));
              }}
              onDrop={() => void handleDrop(record.id)}
            >
              <GripVertical aria-label="拖动排序" className="size-4 cursor-grab text-slate-300" />
              <div className="min-w-0">
                <p className="flex min-w-0 items-center gap-1.5 truncate font-medium text-slate-900">
                  <span className="truncate">{record.foodNameSnapshot}</span>
                  {record.amountMode === 'recommended' ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700"
                      title="该用量会随本餐后续记录自动调整"
                    >
                      <Sparkles className="size-2.5" />
                      推荐量
                      {record.recommendationMetric
                        ? `·${NUTRITION_METRIC_LABELS[record.recommendationMetric]}`
                        : ''}
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {record.categorySnapshot}
                  {record.brandSnapshot ? ` · ${record.brandSnapshot}` : ''}
                  {!record.countInNutritionSnapshot ? ' · 不计入统计' : ''}
                </p>
              </div>
              <div className="text-right text-slate-700">
                {formatMealAmount(record.amount, record.unitType)}
                {record.unitType === 'gram' ? 'g' : record.unitNameSnapshot || '份'}
              </div>
              <div className="text-right text-slate-700">{formatNutrition(record.calories, 1)}</div>
              <div className="text-right text-slate-700">{formatNutrition(record.protein, 1)}g</div>
              <div className="text-right text-slate-700">{formatNutrition(record.carbs, 1)}g</div>
              <div className="text-right text-slate-700">{formatNutrition(record.fat, 1)}g</div>
              <div className="flex justify-end gap-1">
                <button
                  aria-label={`编辑 ${record.foodNameSnapshot}`}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                  disabled={pending}
                  onClick={() => onEdit(record)}
                  type="button"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  aria-label={`删除 ${record.foodNameSnapshot}`}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  disabled={pending}
                  onClick={() => void handleDelete(record)}
                  type="button"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {records.length > 0 && !isIndulgence ? (
        <footer className="grid min-w-[590px] grid-cols-[1fr_repeat(4,62px)_74px] gap-2 overflow-x-auto border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          <span className="font-medium">本餐合计</span>
          <span className="text-right">{formatNutrition(total.calories, 1)} kcal</span>
          <span className="text-right">{formatNutrition(total.protein, 1)}g</span>
          <span className="text-right">{formatNutrition(total.carbs, 1)}g</span>
          <span className="text-right">{formatNutrition(total.fat, 1)}g</span>
          <span />
        </footer>
      ) : null}
      {error ? (
        <p className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</p>
      ) : null}
    </section>
  );
}
