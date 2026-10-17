import { CheckCircle2, GripVertical, Pencil, Pill, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage } from '../services/api';
import { confirmAction } from '../stores/confirmation-store';
import { useAppStore } from '../stores/app-store';
import type { Food, MealRecord } from '../types/models';
import { formatMealAmount } from '../utils/meal-amount';
import { formatSupplementDosage, formatSupplementFrequency } from '../utils/supplements';

interface SupplementSectionProps {
  records: MealRecord[];
  completionRecords: MealRecord[];
  recommendations: Food[];
  onAdd: () => void;
  onEdit: (record: MealRecord) => void;
}

const EMPTY_RECORDED_FOOD_IDS: ReadonlySet<number> = new Set();

/** 展示用户自设的当日补剂计划，并管理与四个餐次并列的补剂记录。 */
export function SupplementSection({
  records,
  completionRecords,
  recommendations,
  onAdd,
  onEdit,
}: SupplementSectionProps) {
  const selectedDate = useAppStore((state) => state.selectedDate);
  const createMealRecord = useAppStore((state) => state.createMealRecord);
  const deleteMealRecord = useAppStore((state) => state.deleteMealRecord);
  const clearMeal = useAppStore((state) => state.clearMeal);
  const reorderMeal = useAppStore((state) => state.reorderMeal);
  const [recordingId, setRecordingId] = useState<number | null>(null);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [locallyRecordedFoodIdsByDate, setLocallyRecordedFoodIdsByDate] = useState<
    Record<string, Set<number>>
  >({});
  const pendingRef = useRef(false);

  useEffect(() => {
    setError(null);
  }, [selectedDate]);

  useEffect(() => {
    const canonicalIds = new Set(
      completionRecords.flatMap((record) => (record.foodId === null ? [] : [record.foodId])),
    );
    setLocallyRecordedFoodIdsByDate((current) => {
      const localIds = current[selectedDate];
      if (!localIds) return current;
      const remainingIds = new Set([...localIds].filter((foodId) => !canonicalIds.has(foodId)));
      if (remainingIds.size === localIds.size) return current;
      const next = { ...current };
      if (remainingIds.size === 0) delete next[selectedDate];
      else next[selectedDate] = remainingIds;
      return next;
    });
  }, [completionRecords, locallyRecordedFoodIdsByDate, selectedDate]);

  const locallyRecordedFoodIds =
    locallyRecordedFoodIdsByDate[selectedDate] ?? EMPTY_RECORDED_FOOD_IDS;

  const recordedFoodIds = useMemo(() => {
    const ids = new Set(
      completionRecords.flatMap((record) => (record.foodId === null ? [] : [record.foodId])),
    );
    locallyRecordedFoodIds.forEach((foodId) => ids.add(foodId));
    return ids;
  }, [completionRecords, locallyRecordedFoodIds]);

  function updateLocallyRecordedFoodIds(
    recordDate: string,
    update: (current: ReadonlySet<number>) => Set<number>,
  ) {
    setLocallyRecordedFoodIdsByDate((current) => {
      const nextIds = update(current[recordDate] ?? EMPTY_RECORDED_FOOD_IDS);
      const next = { ...current };
      if (nextIds.size === 0) delete next[recordDate];
      else next[recordDate] = nextIds;
      return next;
    });
  }

  async function recordRecommendation(supplement: Food) {
    if (pendingRef.current || recordedFoodIds.has(supplement.id)) return;
    const amount = supplement.supplementDosage;
    if (amount === null || !Number.isFinite(amount) || amount <= 0) {
      setError(`“${supplement.name}”没有有效的计划用量，请先在补剂库中完善。`);
      return;
    }
    if (supplement.supplementDosageUnit === 'serving' && !supplement.defaultServingGrams) {
      setError(`“${supplement.name}”按份记录，但尚未设置默认每份重量。`);
      return;
    }

    const recordDate = selectedDate;
    pendingRef.current = true;
    setPending(true);
    setRecordingId(supplement.id);
    setError(null);
    try {
      await createMealRecord({
        recordDate,
        mealType: 'supplement',
        foodId: supplement.id,
        amount,
        unitType: supplement.supplementDosageUnit,
        note: '',
      });
      // 写入成功但 Dashboard 刷新失败时也要立即锁定按钮，避免同一计划被重复记录。
      updateLocallyRecordedFoodIds(recordDate, (current) => new Set(current).add(supplement.id));
    } catch (recordError) {
      if (useAppStore.getState().selectedDate === recordDate) {
        setError(getErrorMessage(recordError));
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
      setRecordingId(null);
    }
  }

  async function handleDelete(record: MealRecord) {
    if (pendingRef.current) return;
    if (!(await confirmAction(`确定删除“${record.foodNameSnapshot}”这条补剂记录吗？`))) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await deleteMealRecord(record.id);
      if (record.foodId !== null) {
        updateLocallyRecordedFoodIds(record.recordDate, (current) => {
          const next = new Set(current);
          next.delete(record.foodId as number);
          return next;
        });
      }
    } catch (deleteError) {
      if (useAppStore.getState().selectedDate === record.recordDate) {
        setError(getErrorMessage(deleteError));
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function handleClear() {
    if (pendingRef.current || records.length === 0) return;
    if (!(await confirmAction(`确定清空当天的全部 ${records.length} 条补剂记录吗？`))) return;
    const recordDate = selectedDate;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await clearMeal('supplement');
      updateLocallyRecordedFoodIds(recordDate, () => new Set());
    } catch (clearError) {
      if (useAppStore.getState().selectedDate === recordDate) {
        setError(getErrorMessage(clearError));
      }
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
      <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50/70 px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <Pill className="size-4 text-emerald-600" />
            <h2 className="font-semibold text-slate-900">补剂记录</h2>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">当天已记录 {records.length} 项</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-200 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={pending || records.length === 0}
            onClick={() => void handleClear()}
            type="button"
          >
            清空记录
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:bg-slate-300"
            disabled={pending}
            onClick={onAdd}
            type="button"
          >
            <Plus className="size-3.5" />
            添加记录
          </button>
        </div>
      </header>

      <div className="border-b border-emerald-100 bg-emerald-50/60 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-emerald-950">当日补剂计划</h3>
            <p className="mt-0.5 text-xs text-emerald-700">根据你在补剂库设置的频率和用量生成</p>
          </div>
          <span className="rounded-full bg-white/80 px-2.5 py-1 text-xs text-emerald-700">
            {recommendations.length} 项
          </span>
        </div>
        {recommendations.length > 0 ? (
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {recommendations.map((supplement) => {
              const recorded = recordedFoodIds.has(supplement.id);
              const validDosage =
                supplement.supplementDosage !== null &&
                Number.isFinite(supplement.supplementDosage) &&
                supplement.supplementDosage > 0 &&
                (supplement.supplementDosageUnit === 'gram' ||
                  Boolean(supplement.defaultServingGrams));
              return (
                <div
                  className="flex items-center gap-3 rounded-lg border border-emerald-100 bg-white px-3 py-2.5"
                  key={supplement.id}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">{supplement.name}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {formatSupplementFrequency(supplement)} · {formatSupplementDosage(supplement)}
                    </p>
                  </div>
                  <button
                    className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                      recorded
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-slate-300'
                    }`}
                    disabled={pending || recorded || !validDosage}
                    onClick={() => void recordRecommendation(supplement)}
                    title={validDosage ? undefined : '请先在补剂库中完善计划用量'}
                    type="button"
                  >
                    {recorded ? (
                      <CheckCircle2 className="size-3.5" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    {recorded ? '已记录' : recordingId === supplement.id ? '记录中…' : '一键记录'}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-xs text-slate-500">
            当日没有按计划需要记录的补剂，按需补剂仍可手动添加。
          </p>
        )}
      </div>

      {records.length === 0 ? (
        <button
          className="flex w-full flex-col items-center justify-center px-4 py-8 text-sm text-slate-400 transition hover:bg-slate-50 hover:text-emerald-700"
          disabled={pending}
          onClick={onAdd}
          type="button"
        >
          <Plus className="mb-1 size-5" />
          尚未记录，点击添加补剂记录
        </button>
      ) : (
        <div className="divide-y divide-slate-100 overflow-x-auto">
          {records.map((record) => (
            <div
              className={`grid min-w-[590px] grid-cols-[24px_minmax(180px,1fr)_120px_minmax(150px,0.8fr)_66px] items-center gap-3 px-3 py-3 text-sm transition ${
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
                <p className="truncate font-medium text-slate-900">{record.foodNameSnapshot}</p>
                <p className="truncate text-xs text-slate-500">
                  {record.brandSnapshot || '未填写品牌'}
                  {!record.countInNutritionSnapshot ? ' · 不计入营养统计' : ''}
                </p>
              </div>
              <div className="text-right text-slate-700">
                {formatMealAmount(record.amount, record.unitType)}
                {record.unitType === 'gram' ? 'g' : record.unitNameSnapshot || '份'}
              </div>
              <p className="truncate text-xs text-slate-500" title={record.note || '无备注'}>
                {record.note || '无备注'}
              </p>
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
      {error ? (
        <p
          aria-live="polite"
          className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
