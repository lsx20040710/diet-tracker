import { Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import type { Food, FoodCombination, FoodCombinationInput, UnitType } from '../types/models';
import {
  isMealAmountValid,
  normalizeMealAmountInput,
  normalizeMealAmountValue,
} from '../utils/meal-amount';
import { formatNutrition } from '../utils/nutrition';
import {
  Field,
  primaryButtonClass,
  secondaryButtonClass,
  SelectInput,
  TextInput,
} from './ui/FormControls';
import { MealAmountInput } from './ui/MealAmountInput';

interface FoodCombinationFormProps {
  initialCombination?: FoodCombination | null;
  onCancel: () => void;
  onSubmit: (input: FoodCombinationInput) => Promise<void>;
}

interface EditableCombinationItem {
  food: Food;
  amount: string;
  unitType: UnitType;
}

/** 组合只保存食物引用与用量，加入餐次时由主进程按最新食物数据生成营养快照。 */
export function FoodCombinationForm({
  initialCombination,
  onCancel,
  onSubmit,
}: FoodCombinationFormProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<EditableCombinationItem[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Food[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(initialCombination?.name ?? '');
    setDescription(initialCombination?.description ?? '');
    setItems(
      initialCombination?.items.map((item) => ({
        food: item.food,
        amount: normalizeMealAmountInput(String(item.amount), item.unitType),
        unitType: item.unitType,
      })) ?? [],
    );
    setSearch('');
    setResults([]);
    setError(null);
  }, [initialCombination]);

  useEffect(() => {
    const keyword = search.trim();
    if (!keyword) {
      setResults([]);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      void getDietTrackerApi()
        // 补剂始终进入独立记录，常用组合只允许选择普通食物。
        .listFoods({ search: keyword, kind: 'food', limit: 20 })
        .then((result) => {
          if (!cancelled) setResults(unwrapApiResult(result));
        })
        .catch((loadError) => {
          if (!cancelled) setError(getErrorMessage(loadError));
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search]);

  function addFood(food: Food) {
    if (items.some((item) => item.food.id === food.id)) {
      setError(`“${food.name}”已经在当前组合中`);
      return;
    }
    const useServing = Boolean(food.defaultServingGrams);
    setItems((current) => [
      ...current,
      {
        food,
        amount: useServing ? '1' : normalizeMealAmountInput('100', 'gram'),
        unitType: useServing ? 'serving' : 'gram',
      },
    ]);
    setSearch('');
    setResults([]);
    setError(null);
  }

  function updateItem(index: number, patch: Partial<Omit<EditableCombinationItem, 'food'>>) {
    setItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('组合名称不能为空');
      return;
    }
    if (items.length === 0) {
      setError('请至少添加一种食物');
      return;
    }
    const parsedItems = items.map((item) => ({
      foodId: item.food.id,
      amount: normalizeMealAmountValue(Number(item.amount), item.unitType),
      unitType: item.unitType,
    }));
    const invalidItem = items.find((item, index) => {
      const parsedItem = parsedItems[index];
      return !isMealAmountValid(parsedItem.amount);
    });
    if (invalidItem) {
      setError(
        invalidItem.unitType === 'gram'
          ? `“${invalidItem.food.name}”的重量必须是大于或等于 0.1 的数字`
          : `“${invalidItem.food.name}”的份数必须是大于或等于 0.1 的数字`,
      );
      return;
    }
    const invalidServing = items.find(
      (item) => item.unitType === 'serving' && !item.food.defaultServingGrams,
    );
    if (invalidServing) {
      setError(`“${invalidServing.food.name}”未设置默认每份重量，请改为按克记录`);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ name: trimmedName, description: description.trim(), items: parsedItems });
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <div className="grid grid-cols-[minmax(220px,0.8fr)_minmax(320px,1.2fr)] gap-4">
        <Field label="组合名称 *">
          <TextInput
            autoFocus
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：早餐组合"
            value={name}
          />
        </Field>
        <Field label="说明">
          <TextInput
            maxLength={300}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="可留空"
            value={description}
          />
        </Field>
      </div>

      <section>
        <h3 className="text-sm font-semibold text-slate-900">组合食物</h3>
        <div className="relative mt-2">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            className="w-full rounded-lg border border-slate-300 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="输入食物名称搜索并添加"
            value={search}
          />
        </div>
        {search.trim() ? (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-slate-200">
            {searchLoading ? (
              <p className="px-3 py-6 text-center text-sm text-slate-500">正在搜索…</p>
            ) : results.length ? (
              results.map((food) => (
                <button
                  className="flex w-full items-center justify-between border-t border-slate-100 px-3 py-2.5 text-left text-sm first:border-t-0 hover:bg-emerald-50"
                  key={food.id}
                  onClick={() => addFood(food)}
                  type="button"
                >
                  <span>
                    <span className="font-medium text-slate-900">{food.name}</span>
                    <span className="ml-2 text-xs text-slate-500">
                      {food.brand || food.category}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-700">
                    <Plus className="size-3.5" /> 添加
                  </span>
                </button>
              ))
            ) : (
              <p className="px-3 py-6 text-center text-sm text-slate-500">没有找到该食物</p>
            )}
          </div>
        ) : null}

        <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
          <div className="grid grid-cols-[minmax(180px,1fr)_150px_150px_90px_auto] gap-3 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-500">
            <span>食物</span>
            <span>记录方式</span>
            <span>重量 / 份数</span>
            <span className="text-right">换算重量</span>
            <span className="w-8" />
          </div>
          {items.length ? (
            <div className="divide-y divide-slate-100">
              {items.map((item, index) => {
                const parsedAmount = Number(item.amount);
                const grams =
                  item.unitType === 'gram'
                    ? parsedAmount
                    : parsedAmount * (item.food.defaultServingGrams ?? 0);
                return (
                  <div
                    className="grid grid-cols-[minmax(180px,1fr)_150px_150px_90px_auto] items-center gap-3 px-4 py-3"
                    key={item.food.id}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">
                        {item.food.name}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {item.food.category} · 每 100g{' '}
                        {formatNutrition(item.food.caloriesPer100g, 1)} kcal
                      </p>
                    </div>
                    <SelectInput
                      aria-label={`${item.food.name}记录方式`}
                      className="mt-0"
                      onChange={(event) => {
                        const unitType = event.target.value as UnitType;
                        updateItem(index, {
                          unitType,
                          amount:
                            unitType === 'serving' ? '1' : normalizeMealAmountInput('100', 'gram'),
                        });
                      }}
                      value={item.unitType}
                    >
                      <option value="gram">按克</option>
                      <option disabled={!item.food.defaultServingGrams} value="serving">
                        按{item.food.unitName || '份'}
                      </option>
                    </SelectInput>
                    <MealAmountInput
                      aria-label={`${item.food.name}数量`}
                      className="mt-0"
                      disabled={submitting}
                      onValueChange={(amount) => updateItem(index, { amount })}
                      unitName={item.food.unitName}
                      unitType={item.unitType}
                      value={item.amount}
                    />
                    <span className="text-right text-sm text-slate-600">
                      {Number.isFinite(grams) && grams > 0 ? `${formatNutrition(grams, 1)}g` : '—'}
                    </span>
                    <button
                      aria-label={`从组合移除 ${item.food.name}`}
                      className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                      onClick={() =>
                        setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))
                      }
                      type="button"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-slate-500">
              搜索食物并加入组合，可连续添加多项。
            </p>
          )}
        </div>
      </section>

      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      <div className="flex justify-end gap-3 border-t border-slate-200 pt-5">
        <button className={secondaryButtonClass} onClick={onCancel} type="button">
          取消
        </button>
        <button className={primaryButtonClass} disabled={submitting} type="submit">
          {submitting ? '正在保存…' : initialCombination ? '保存组合' : '创建组合'}
        </button>
      </div>
    </form>
  );
}
