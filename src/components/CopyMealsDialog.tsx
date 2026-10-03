import { Copy, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { useAppStore } from '../stores/app-store';
import { MEAL_TYPES, type MealType } from '../types/models';
import { mealLabels } from './meal-labels';
import { Field, primaryButtonClass, secondaryButtonClass, TextInput } from './ui/FormControls';
import { Modal } from './ui/Modal';

interface CopyMealsDialogProps {
  open: boolean;
  sourceDate: string;
  initialTargetDate: string;
  fixedMealType?: MealType;
  title?: string;
  onClose: () => void;
  onCopied?: (copiedCount: number, targetDate: string) => void | Promise<void>;
}

type MealCounts = Record<MealType, number>;

const emptyMealCounts = (): MealCounts => ({
  breakfast: 0,
  lunch: 0,
  dinner: 0,
  snack: 0,
  supplement: 0,
});

/**
 * 复制指定日期的餐次，并在目标已有数据时要求用户明确选择追加或覆盖。
 */
export function CopyMealsDialog({
  open,
  sourceDate,
  initialTargetDate,
  fixedMealType,
  title,
  onClose,
  onCopied,
}: CopyMealsDialogProps) {
  const selectedDate = useAppStore((state) => state.selectedDate);
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const beginSaving = useAppStore((state) => state.beginSaving);
  const finishSaving = useAppStore((state) => state.finishSaving);
  const reportSaveError = useAppStore((state) => state.reportSaveError);
  const [targetDate, setTargetDate] = useState(initialTargetDate);
  const [selectedMealTypes, setSelectedMealTypes] = useState<MealType[]>(
    fixedMealType ? [fixedMealType] : [...MEAL_TYPES],
  );
  const [sourceCounts, setSourceCounts] = useState<MealCounts>(emptyMealCounts);
  const [targetCounts, setTargetCounts] = useState<MealCounts>(emptyMealCounts);
  const [replaceExisting, setReplaceExisting] = useState<boolean | null>(null);
  const [inspectionSucceeded, setInspectionSucceeded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTargetDate(initialTargetDate);
    setSelectedMealTypes(fixedMealType ? [fixedMealType] : [...MEAL_TYPES]);
    setSourceCounts(emptyMealCounts());
    setTargetCounts(emptyMealCounts());
    setReplaceExisting(null);
    setInspectionSucceeded(false);
    setError(null);
  }, [fixedMealType, initialTargetDate, open, sourceDate]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSourceCounts(emptyMealCounts());
    setTargetCounts(emptyMealCounts());
    setInspectionSucceeded(false);
    setReplaceExisting(null);
    if (!targetDate) {
      setLoading(false);
      return;
    }
    void Promise.all([
      getDietTrackerApi().getDashboard(sourceDate),
      getDietTrackerApi().getDashboard(targetDate),
    ])
      .then(([sourceResult, targetResult]) => {
        const source = unwrapApiResult(sourceResult);
        const target = unwrapApiResult(targetResult);
        if (cancelled) return;
        const nextSourceCounts: MealCounts = {
          breakfast: source.meals.breakfast.length,
          lunch: source.meals.lunch.length,
          dinner: source.meals.dinner.length,
          snack: source.meals.snack.length,
          supplement: source.meals.supplement.length,
        };
        setSourceCounts(nextSourceCounts);
        // 没有来源记录的餐次不参与覆盖，防止用户误以为会清空目标餐次。
        if (!fixedMealType) {
          setSelectedMealTypes((current) =>
            current.filter((mealType) => nextSourceCounts[mealType] > 0),
          );
        }
        setTargetCounts({
          breakfast: target.meals.breakfast.length,
          lunch: target.meals.lunch.length,
          dinner: target.meals.dinner.length,
          snack: target.meals.snack.length,
          supplement: target.meals.supplement.length,
        });
        setInspectionSucceeded(true);
        setReplaceExisting(null);
      })
      .catch((loadError) => {
        if (!cancelled) setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fixedMealType, open, sourceDate, targetDate]);

  const availableCount = useMemo(
    () => selectedMealTypes.reduce((sum, mealType) => sum + sourceCounts[mealType], 0),
    [selectedMealTypes, sourceCounts],
  );
  const targetHasRecords = selectedMealTypes.some((mealType) => targetCounts[mealType] > 0);

  function toggleMealType(mealType: MealType) {
    if (fixedMealType) return;
    setSelectedMealTypes((current) =>
      current.includes(mealType)
        ? current.filter((candidate) => candidate !== mealType)
        : MEAL_TYPES.filter((candidate) => [...current, mealType].includes(candidate)),
    );
    setReplaceExisting(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedMealTypes.length === 0) {
      setError('请至少选择一个餐次');
      return;
    }
    if (!inspectionSucceeded) {
      setError('来源和目标记录尚未检查成功，请重试');
      return;
    }
    if (sourceDate === targetDate) {
      setError('来源日期与目标日期不能相同');
      return;
    }
    if (availableCount === 0) {
      setError('所选餐次在来源日期没有可复制的记录');
      return;
    }
    if (targetHasRecords && replaceExisting === null) {
      setError('目标日期已有所选餐次记录，请选择追加或覆盖');
      return;
    }

    setSubmitting(true);
    setError(null);
    beginSaving();
    try {
      const result = unwrapApiResult(
        await getDietTrackerApi().copyMeals({
          sourceDate,
          targetDate,
          mealTypes: selectedMealTypes,
          replaceExisting: targetHasRecords ? Boolean(replaceExisting) : false,
        }),
      );
      if (targetDate === selectedDate) await loadDashboard(targetDate);
      finishSaving();
      await onCopied?.(result.copiedCount, targetDate);
      onClose();
    } catch (copyError) {
      const message = getErrorMessage(copyError);
      setError(message);
      reportSaveError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      closeDisabled={submitting}
      description={`来源日期：${sourceDate}`}
      onClose={onClose}
      open={open}
      title={title ?? (fixedMealType ? `复制前一天${mealLabels[fixedMealType]}` : '复制历史记录')}
      widthClassName="max-w-xl"
    >
      <form className="space-y-5" onSubmit={handleSubmit}>
        <Field label="复制到日期">
          <TextInput
            disabled={submitting}
            onChange={(event) => setTargetDate(event.target.value)}
            required
            type="date"
            value={targetDate}
          />
        </Field>

        <fieldset>
          <legend className="text-sm font-medium text-slate-700">选择餐次</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {MEAL_TYPES.map((mealType) => {
              const checked = selectedMealTypes.includes(mealType);
              return (
                <label
                  className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                    checked
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                      : 'border-slate-200 text-slate-600'
                  } ${fixedMealType && mealType !== fixedMealType ? 'hidden' : ''}`}
                  key={mealType}
                >
                  <span className="flex items-center gap-2">
                    <input
                      checked={checked}
                      className="size-4 accent-emerald-600"
                      disabled={
                        submitting || Boolean(fixedMealType) || sourceCounts[mealType] === 0
                      }
                      onChange={() => toggleMealType(mealType)}
                      type="checkbox"
                    />
                    {mealLabels[mealType]}
                  </span>
                  <span className="text-xs text-slate-500">来源 {sourceCounts[mealType]} 条</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {loading ? (
          <p className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
            <LoaderCircle className="size-4 animate-spin" />
            正在检查来源与目标记录…
          </p>
        ) : !inspectionSucceeded ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            记录检查尚未成功，请确认目标日期并重试。
          </p>
        ) : targetHasRecords ? (
          <fieldset className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <legend className="px-1 text-sm font-semibold text-amber-900">目标已有记录</legend>
            <p className="mb-3 text-xs leading-5 text-amber-800">
              请选择如何处理目标日期中已存在的所选餐次。覆盖只清空所选餐次，其他餐次保持不变。
            </p>
            <div className="flex gap-5 text-sm text-amber-950">
              <label className="flex items-center gap-2">
                <input
                  checked={replaceExisting === false}
                  className="size-4 accent-emerald-600"
                  disabled={submitting}
                  onChange={() => setReplaceExisting(false)}
                  type="radio"
                />
                追加到现有记录
              </label>
              <label className="flex items-center gap-2">
                <input
                  checked={replaceExisting === true}
                  className="size-4 accent-red-600"
                  disabled={submitting}
                  onChange={() => setReplaceExisting(true)}
                  type="radio"
                />
                覆盖所选餐次
              </label>
            </div>
          </fieldset>
        ) : (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            目标日期的所选餐次为空，将直接复制。
          </p>
        )}

        {error ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        ) : null}
        <div className="flex justify-end gap-3 border-t border-slate-200 pt-5">
          <button
            className={secondaryButtonClass}
            disabled={submitting}
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className={primaryButtonClass}
            disabled={loading || submitting || !inspectionSucceeded || availableCount === 0}
            type="submit"
          >
            <Copy className="size-4" />
            {submitting ? '正在复制…' : `复制 ${availableCount} 条记录`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
