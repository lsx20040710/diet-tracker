import { CheckCircle2, Pencil, Plus, Trash2, Utensils } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { useAppStore } from '../stores/app-store';
import type { FoodCombination, FoodCombinationInput, MealType } from '../types/models';
import { formatMealAmount } from '../utils/meal-amount';
import { FoodCombinationForm } from './FoodCombinationForm';
import { mealLabels } from './meal-labels';
import { primaryButtonClass, secondaryButtonClass, SelectInput } from './ui/FormControls';
import { Modal } from './ui/Modal';

type CombinationDialogState =
  { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; combination: FoodCombination };

/** 管理真实常用组合，并把组合中的全部项目一次写入指定日期和餐次。 */
export function FoodCombinationsPanel() {
  const selectedDate = useAppStore((state) => state.selectedDate);
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const beginSaving = useAppStore((state) => state.beginSaving);
  const finishSaving = useAppStore((state) => state.finishSaving);
  const reportSaveError = useAppStore((state) => state.reportSaveError);
  const [combinations, setCombinations] = useState<FoodCombination[]>([]);
  const [targetDate, setTargetDate] = useState(selectedDate);
  const [mealType, setMealType] = useState<MealType>('breakfast');
  const [dialog, setDialog] = useState<CombinationDialogState>({ mode: 'closed' });
  const [loading, setLoading] = useState(true);
  const [addingId, setAddingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const deletePending = useRef(false);

  const loadCombinations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCombinations(unwrapApiResult(await getDietTrackerApi().listFoodCombinations()));
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCombinations();
  }, [loadCombinations]);

  async function handleSubmit(input: FoodCombinationInput) {
    beginSaving();
    try {
      if (dialog.mode === 'edit') {
        unwrapApiResult(
          await getDietTrackerApi().updateFoodCombination(dialog.combination.id, input),
        );
      } else {
        unwrapApiResult(await getDietTrackerApi().createFoodCombination(input));
      }
      await loadCombinations();
      finishSaving();
      setDialog({ mode: 'closed' });
    } catch (submitError) {
      reportSaveError(getErrorMessage(submitError));
      throw submitError;
    }
  }

  async function handleDelete(combination: FoodCombination) {
    if (deletePending.current) return;
    deletePending.current = true;
    if (!window.confirm(`确定删除常用组合“${combination.name}”吗？`)) {
      deletePending.current = false;
      return;
    }
    setDeletingId(combination.id);
    beginSaving();
    setError(null);
    try {
      unwrapApiResult(await getDietTrackerApi().deleteFoodCombination(combination.id));
      await loadCombinations();
      finishSaving();
    } catch (deleteError) {
      const message = getErrorMessage(deleteError);
      setError(message);
      reportSaveError(message);
    } finally {
      setDeletingId(null);
      deletePending.current = false;
    }
  }

  async function handleAddToMeal(combination: FoodCombination) {
    setAddingId(combination.id);
    setFeedback(null);
    setError(null);
    beginSaving();
    try {
      const records = unwrapApiResult(
        await getDietTrackerApi().addCombinationToMeal({
          combinationId: combination.id,
          recordDate: targetDate,
          mealType,
        }),
      );
      if (targetDate === selectedDate) await loadDashboard(targetDate);
      finishSaving();
      setFeedback(
        `已将“${combination.name}”的 ${records.length} 项食物加入 ${targetDate} ${mealLabels[mealType]}。`,
      );
    } catch (addError) {
      const message = getErrorMessage(addError);
      setError(message);
      reportSaveError(message);
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-end gap-3 border-b border-slate-200 p-4">
        <label className="text-xs font-medium text-slate-600">
          加入日期
          <input
            className="mt-1.5 block rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            onChange={(event) => setTargetDate(event.target.value)}
            required
            type="date"
            value={targetDate}
          />
        </label>
        <label className="w-40 text-xs font-medium text-slate-600">
          加入餐次
          <SelectInput
            className="mt-1.5"
            onChange={(event) => setMealType(event.target.value as MealType)}
            value={mealType}
          >
            {Object.entries(mealLabels)
              .filter(([value]) => value !== 'supplement')
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </SelectInput>
        </label>
        <p className="min-w-0 flex-1 pb-2 text-xs text-slate-500">
          组合加入后会为每项食物创建独立饮食快照，可继续单独编辑。
        </p>
        <button
          className={primaryButtonClass}
          onClick={() => setDialog({ mode: 'create' })}
          type="button"
        >
          <Plus className="size-4" />
          新增组合
        </button>
      </div>

      {feedback ? (
        <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="size-4" />
          {feedback}
        </div>
      ) : null}
      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
          <button
            className="ml-3 font-medium underline"
            onClick={() => void loadCombinations()}
            type="button"
          >
            重试
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex h-56 items-center justify-center text-sm text-slate-500">
            正在读取常用组合…
          </div>
        ) : combinations.length ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {combinations.map((combination) => (
              <article
                className="flex min-h-52 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                key={combination.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-slate-900">{combination.name}</h3>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      {combination.description || '无说明'}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      aria-label={`编辑 ${combination.name}`}
                      className="rounded-md p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      onClick={() => setDialog({ mode: 'edit', combination })}
                      type="button"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      aria-label={`删除 ${combination.name}`}
                      className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      disabled={deletingId !== null}
                      onClick={() => void handleDelete(combination)}
                      type="button"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-3 flex-1 space-y-1.5 rounded-lg bg-slate-50 p-3">
                  {combination.items.map((item) => (
                    <div className="flex items-center justify-between gap-3 text-sm" key={item.id}>
                      <span className="min-w-0 truncate text-slate-700">{item.food.name}</span>
                      <span className="shrink-0 text-slate-500">
                        {formatMealAmount(item.amount, item.unitType)}
                        {item.unitType === 'gram' ? 'g' : item.food.unitName || '份'}
                      </span>
                    </div>
                  ))}
                </div>
                <button
                  className={`${secondaryButtonClass} mt-4 w-full border-emerald-200 text-emerald-700 hover:bg-emerald-50`}
                  disabled={addingId !== null || !targetDate}
                  onClick={() => void handleAddToMeal(combination)}
                  type="button"
                >
                  <Utensils className="size-4" />
                  {addingId === combination.id ? '正在加入…' : `一键加入${mealLabels[mealType]}`}
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="flex h-56 flex-col items-center justify-center text-sm text-slate-500">
            <p>还没有常用组合</p>
            <button
              className="mt-3 font-medium text-emerald-700"
              onClick={() => setDialog({ mode: 'create' })}
              type="button"
            >
              创建第一个组合
            </button>
          </div>
        )}
      </div>

      <Modal
        onClose={() => setDialog({ mode: 'closed' })}
        open={dialog.mode !== 'closed'}
        title={dialog.mode === 'edit' ? '编辑常用组合' : '新增常用组合'}
        widthClassName="max-w-4xl"
      >
        {dialog.mode !== 'closed' ? (
          <FoodCombinationForm
            initialCombination={dialog.mode === 'edit' ? dialog.combination : null}
            onCancel={() => setDialog({ mode: 'closed' })}
            onSubmit={handleSubmit}
          />
        ) : null}
      </Modal>
    </div>
  );
}
