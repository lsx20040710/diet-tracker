import { ChevronLeft, Clock3, Library, Search, Sparkles, Star } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { useAppStore } from '../stores/app-store';
import {
  CORE_MEAL_TYPES,
  type CoreMealType,
  type Food,
  type FoodScope,
  type MealRecord,
  type MealType,
  type UnitType,
} from '../types/models';
import { calculateRecommendedMealAmount, NUTRITION_METRIC_LABELS } from '../utils/meal-allocation';
import {
  calculateNutritionByGrams,
  calculateNutritionByServing,
  formatNutrition,
} from '../utils/nutrition';
import {
  isMealAmountValid,
  normalizeMealAmountInput,
  normalizeMealAmountValue,
} from '../utils/meal-amount';
import { formatSupplementDosage } from '../utils/supplements';
import { FoodForm } from './FoodForm';
import { mealLabels, REGULAR_MEAL_TYPES } from './meal-labels';
import {
  Field,
  primaryButtonClass,
  secondaryButtonClass,
  SelectInput,
  TextInput,
} from './ui/FormControls';
import { Modal } from './ui/Modal';
import { MealAmountInput } from './ui/MealAmountInput';

interface AddMealRecordDialogProps {
  open: boolean;
  initialMealType: MealType;
  onClose: () => void;
}

type DialogStep = 'search' | 'create' | 'amount';

export function AddMealRecordDialog({ open, initialMealType, onClose }: AddMealRecordDialogProps) {
  const supplementMode = initialMealType === 'supplement';
  const selectedDate = useAppStore((state) => state.selectedDate);
  const dashboard = useAppStore((state) => state.dashboard);
  const createMealRecord = useAppStore((state) => state.createMealRecord);
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const beginSaving = useAppStore((state) => state.beginSaving);
  const finishSaving = useAppStore((state) => state.finishSaving);
  const reportSaveError = useAppStore((state) => state.reportSaveError);
  const [step, setStep] = useState<DialogStep>('search');
  const [mealType, setMealType] = useState<MealType>(initialMealType);
  const [search, setSearch] = useState('');
  const [foodScope, setFoodScope] = useState<FoodScope>('recent');
  const [foods, setFoods] = useState<Food[]>([]);
  const [selectedFood, setSelectedFood] = useState<Food | null>(null);
  const [unitType, setUnitType] = useState<UnitType>('gram');
  const [amount, setAmount] = useState('100.0');
  const [amountMode, setAmountMode] = useState<'manual' | 'recommended'>('manual');
  const [recommendationFeedback, setRecommendationFeedback] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('search');
    setMealType(initialMealType);
    setSearch('');
    setFoodScope(supplementMode ? 'all' : 'recent');
    setSelectedFood(null);
    setUnitType('gram');
    setAmount('100.0');
    setAmountMode('manual');
    setRecommendationFeedback(null);
    setNote('');
    setError(null);
  }, [initialMealType, open, supplementMode]);

  useEffect(() => {
    if (!open || step !== 'search') return;
    let cancelled = false;
    const timer = window.setTimeout(
      async () => {
        setLoading(true);
        setError(null);
        try {
          const result = unwrapApiResult(
            await getDietTrackerApi().listFoods(
              search.trim()
                ? {
                    search: search.trim(),
                    kind: supplementMode ? 'supplement' : 'food',
                    limit: 50,
                  }
                : {
                    scope: foodScope,
                    kind: supplementMode ? 'supplement' : 'food',
                    limit: foodScope === 'recent' ? 20 : 100,
                  },
            ),
          );
          if (!cancelled) setFoods(result);
        } catch (loadError) {
          if (!cancelled) setError(getErrorMessage(loadError));
        } finally {
          if (!cancelled) setLoading(false);
        }
      },
      search ? 120 : 0,
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [foodScope, open, search, step, supplementMode]);

  const preview = useMemo(() => {
    if (!selectedFood) return null;
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return null;
    const normalizedAmount = normalizeMealAmountValue(parsedAmount, unitType);
    const per100g = {
      calories: selectedFood.caloriesPer100g,
      protein: selectedFood.proteinPer100g,
      carbs: selectedFood.carbsPer100g,
      fat: selectedFood.fatPer100g,
    };
    try {
      return unitType === 'gram'
        ? calculateNutritionByGrams(per100g, normalizedAmount)
        : calculateNutritionByServing(
            per100g,
            normalizedAmount,
            selectedFood.defaultServingGrams ?? 0,
          );
    } catch {
      return null;
    }
  }, [amount, selectedFood, unitType]);

  const currentMealAllocation =
    !supplementMode &&
    dashboard?.date === selectedDate &&
    CORE_MEAL_TYPES.includes(mealType as CoreMealType)
      ? dashboard.mealAllocation.meals[mealType as CoreMealType]
      : null;

  function selectFood(food: Food) {
    setSelectedFood(food);
    setAmountMode('manual');
    setRecommendationFeedback(null);
    const canUseServing = Boolean(food.defaultServingGrams && food.defaultServingGrams > 0);
    const plannedDosage = food.supplementDosage;
    if (
      supplementMode &&
      plannedDosage !== null &&
      Number.isFinite(plannedDosage) &&
      plannedDosage > 0 &&
      (food.supplementDosageUnit === 'gram' || canUseServing)
    ) {
      // 手动记录补剂时沿用用户保存的计划用量，仍允许在下一步调整。
      setUnitType(food.supplementDosageUnit);
      setAmount(normalizeMealAmountInput(String(plannedDosage), food.supplementDosageUnit));
      setStep('amount');
      setError(null);
      return;
    }
    setUnitType(canUseServing ? 'serving' : 'gram');
    setAmount(canUseServing ? '1' : normalizeMealAmountInput('100', 'gram'));
    setStep('amount');
    setError(null);
  }

  function handleRecommendAmount() {
    if (!selectedFood || !currentMealAllocation) {
      setError('早餐、午餐和晚餐设置了目标后才可推荐摄入量');
      return;
    }
    if (!selectedFood.countInNutrition) {
      setError('该食物不计入营养统计，无法按本餐剩余目标推荐摄入量');
      return;
    }
    const recommendation = calculateRecommendedMealAmount({
      nutritionPer100g: {
        calories: selectedFood.caloriesPer100g,
        protein: selectedFood.proteinPer100g,
        carbs: selectedFood.carbsPer100g,
        fat: selectedFood.fatPer100g,
      },
      remaining: currentMealAllocation.remaining,
      unitType,
      servingGrams: selectedFood.defaultServingGrams,
      unitName: selectedFood.unitName,
    });
    if (!recommendation) {
      setError('该食物在当前剩余目标下没有可用的正数推荐量');
      setRecommendationFeedback(null);
      return;
    }
    setAmount(normalizeMealAmountInput(String(recommendation.amount), unitType));
    setAmountMode('recommended');
    setRecommendationFeedback(
      `按${NUTRITION_METRIC_LABELS[recommendation.limitingMetric]}最先达到目标计算；保存后会随本餐后续记录自动调整。`,
    );
    setError(null);
  }

  async function createFood(input: Parameters<Window['dietTracker']['createFood']>[0]) {
    beginSaving();
    try {
      const food = unwrapApiResult(await getDietTrackerApi().createFood(input));
      if (supplementMode && !(await loadDashboard(selectedDate))) {
        // 补剂已经落库，但推荐快照不可用时先退出，避免继续基于旧页面写入记录。
        finishSaving();
        onClose();
        return;
      }
      finishSaving();
      selectFood(food);
    } catch (createError) {
      reportSaveError(getErrorMessage(createError));
      throw createError;
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFood) return;
    const parsedAmount = Number(amount);
    const normalizedAmount = normalizeMealAmountValue(parsedAmount, unitType);
    if (!isMealAmountValid(normalizedAmount)) {
      setError(
        unitType === 'gram'
          ? `${supplementMode ? '服用量' : '食用重量'}必须是大于或等于 0.1 的数字`
          : `${supplementMode ? '服用份数' : '份数'}必须是大于或等于 0.1 的数字`,
      );
      return;
    }
    if (unitType === 'serving' && !selectedFood.defaultServingGrams) {
      setError(
        supplementMode
          ? '该补剂没有设置默认每份重量，请改用按克记录'
          : '该食物没有设置默认每份重量，请改用按克记录',
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await createMealRecord({
        recordDate: selectedDate,
        mealType,
        foodId: selectedFood.id,
        amount: normalizedAmount,
        unitType,
        amountMode,
        note: note.trim(),
      });
      onClose();
    } catch (addError) {
      setError(getErrorMessage(addError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      closeDisabled={submitting}
      description={`记录日期：${selectedDate}`}
      onClose={onClose}
      open={open}
      title={
        step === 'create'
          ? supplementMode
            ? '创建新补剂'
            : '创建新食物'
          : step === 'amount'
            ? supplementMode
              ? '填写服用量'
              : '填写食用数量'
            : supplementMode
              ? '添加补剂记录'
              : '添加食物'
      }
      widthClassName="max-w-3xl"
    >
      {step === 'search' ? (
        <div>
          <div className={supplementMode ? '' : 'grid grid-cols-[1fr_150px] gap-3'}>
            <label className="relative block">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <input
                aria-label={supplementMode ? '搜索补剂名称' : '搜索食物名称'}
                autoFocus
                className="w-full rounded-lg border border-slate-300 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={supplementMode ? '搜索补剂名称' : '搜索食物名称'}
                value={search}
              />
            </label>
            {!supplementMode ? (
              <SelectInput
                aria-label="选择餐次"
                className="mt-0"
                onChange={(event) => {
                  setMealType(event.target.value as MealType);
                  setAmountMode('manual');
                  setRecommendationFeedback(null);
                }}
                value={mealType}
              >
                {REGULAR_MEAL_TYPES.map((value) => (
                  <option key={value} value={value}>
                    加入{mealLabels[value]}
                  </option>
                ))}
              </SelectInput>
            ) : null}
          </div>

          {!search.trim() ? (
            <div className="mt-3 flex gap-1 rounded-lg bg-slate-100 p-1" role="tablist">
              {(
                [
                  ['recent', supplementMode ? '最近服用' : '最近使用', Clock3],
                  ['favorite', supplementMode ? '常用补剂' : '常用食物', Star],
                  ['all', supplementMode ? '全部补剂' : '全部食物', Library],
                ] as const
              ).map(([scope, label, Icon]) => (
                <button
                  aria-selected={foodScope === scope}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition ${
                    foodScope === scope
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                  key={scope}
                  onClick={() => setFoodScope(scope)}
                  role="tab"
                  type="button"
                >
                  <Icon className={`size-4 ${scope === 'favorite' ? 'fill-current' : ''}`} />
                  {label}
                  {scope === 'recent' ? (
                    <span className="text-xs text-slate-400">最多 20 项</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-500">
              搜索结果按完全匹配、名称开头、名称包含、拼音首字母和历史记录次数排序。
            </p>
          )}

          {error ? (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : null}
          <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
            <div className="grid grid-cols-[minmax(160px,1fr)_repeat(4,86px)_90px] bg-slate-50 px-4 py-2 text-xs font-medium text-slate-500">
              <span>{supplementMode ? '补剂' : '食物'}</span>
              <span className="text-right">热量</span>
              <span className="text-right">蛋白质</span>
              <span className="text-right">碳水</span>
              <span className="text-right">脂肪</span>
              <span className="text-right">{supplementMode ? '计划用量' : '分类'}</span>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {loading ? (
                <p className="px-4 py-10 text-center text-sm text-slate-500">正在搜索…</p>
              ) : foods.length > 0 ? (
                foods.map((food) => (
                  <button
                    className="grid w-full grid-cols-[minmax(160px,1fr)_repeat(4,86px)_90px] items-center border-t border-slate-100 px-4 py-3 text-left text-sm transition first:border-t-0 hover:bg-emerald-50 focus-visible:bg-emerald-50 focus-visible:outline-none"
                    key={food.id}
                    onClick={() => selectFood(food)}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-medium text-slate-900">
                        <span className="truncate">{food.name}</span>
                        {food.isFavorite ? (
                          <Star className="size-3.5 fill-amber-400 text-amber-400" />
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-slate-500">
                        {food.brand || '无品牌'} · 每 100g
                      </span>
                    </span>
                    <span className="text-right text-slate-700">
                      {formatNutrition(food.caloriesPer100g, 1)}
                    </span>
                    <span className="text-right text-slate-700">
                      {formatNutrition(food.proteinPer100g, 1)}g
                    </span>
                    <span className="text-right text-slate-700">
                      {formatNutrition(food.carbsPer100g, 1)}g
                    </span>
                    <span className="text-right text-slate-700">
                      {formatNutrition(food.fatPer100g, 1)}g
                    </span>
                    <span className="text-right text-slate-500">
                      {supplementMode ? formatSupplementDosage(food) : food.category}
                    </span>
                  </button>
                ))
              ) : (
                <div className="px-4 py-10 text-center">
                  <p className="text-sm text-slate-600">
                    {search.trim()
                      ? `没有找到“${search.trim()}”`
                      : foodScope === 'recent'
                        ? supplementMode
                          ? '还没有最近服用的补剂'
                          : '还没有最近使用的食物'
                        : foodScope === 'favorite'
                          ? supplementMode
                            ? '还没有标记常用的补剂'
                            : '还没有标记常用的食物'
                          : supplementMode
                            ? '补剂库暂时为空'
                            : '食物库暂时为空'}
                  </p>
                  {!search.trim() && foodScope !== 'all' ? (
                    <button
                      className="mt-3 text-sm font-medium text-emerald-700 hover:text-emerald-800"
                      onClick={() => setFoodScope('all')}
                      type="button"
                    >
                      查看全部{supplementMode ? '补剂' : '食物'}
                    </button>
                  ) : (
                    <button
                      className="mt-3 text-sm font-medium text-emerald-700 hover:text-emerald-800"
                      onClick={() => setStep('create')}
                      type="button"
                    >
                      {supplementMode ? '创建新补剂' : '创建新食物'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          {foods.length > 0 && search.trim() ? (
            <div className="mt-4 flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
              <span>结果中没有需要的{supplementMode ? '补剂' : '食物'}？</span>
              <button
                className="font-medium text-emerald-700 hover:text-emerald-800"
                onClick={() => setStep('create')}
                type="button"
              >
                创建“{search.trim()}”
              </button>
            </div>
          ) : null}
        </div>
      ) : step === 'create' ? (
        <FoodForm
          initialName={search.trim()}
          kind={supplementMode ? 'supplement' : 'food'}
          onCancel={() => setStep('search')}
          onSubmit={createFood}
          onSubmittingChange={setSubmitting}
          submitLabel={supplementMode ? '保存并继续记录' : '保存并继续添加'}
        />
      ) : selectedFood ? (
        <form className="space-y-5" onSubmit={handleAdd}>
          <button
            className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
            onClick={() => setStep('search')}
            type="button"
          >
            <ChevronLeft className="size-4" />
            重新选择{supplementMode ? '补剂' : '食物'}
          </button>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-slate-900">{selectedFood.name}</h3>
                <p className="mt-1 text-sm text-slate-500">
                  {selectedFood.brand || '无品牌'} · {selectedFood.category}
                </p>
              </div>
              {!selectedFood.countInNutrition ? (
                <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs text-slate-600">
                  不计入营养统计
                </span>
              ) : null}
            </div>
          </div>
          <div className={`grid gap-4 ${supplementMode ? 'grid-cols-2' : 'grid-cols-3'}`}>
            {!supplementMode ? (
              <Field label="加入餐次">
                <SelectInput
                  onChange={(event) => {
                    setMealType(event.target.value as MealType);
                    setAmountMode('manual');
                    setRecommendationFeedback(null);
                  }}
                  value={mealType}
                >
                  {REGULAR_MEAL_TYPES.map((value) => (
                    <option key={value} value={value}>
                      {mealLabels[value]}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            ) : null}
            <Field label="记录方式">
              <SelectInput
                onChange={(event) => {
                  const nextUnit = event.target.value as UnitType;
                  setUnitType(nextUnit);
                  setAmountMode('manual');
                  setRecommendationFeedback(null);
                  setAmount(nextUnit === 'serving' ? '1' : normalizeMealAmountInput('100', 'gram'));
                }}
                value={unitType}
              >
                <option value="gram">按克记录</option>
                <option disabled={!selectedFood.defaultServingGrams} value="serving">
                  按{selectedFood.unitName || '份'}记录
                  {selectedFood.defaultServingGrams
                    ? `（每${selectedFood.unitName || '份'} ${selectedFood.defaultServingGrams}g）`
                    : '（未设置份量）'}
                </option>
              </SelectInput>
            </Field>
            <Field
              label={
                unitType === 'gram'
                  ? supplementMode
                    ? '服用量 (g)'
                    : '食用重量 (g)'
                  : `${supplementMode ? '服用份数' : '数量'} (${selectedFood.unitName || '份'})`
              }
            >
              <MealAmountInput
                aria-label="食物数量"
                autoFocus
                disabled={submitting}
                onValueChange={(value) => {
                  setAmount(value);
                  setAmountMode('manual');
                  setRecommendationFeedback(null);
                }}
                unitName={selectedFood.unitName}
                unitType={unitType}
                value={amount}
              />
            </Field>
          </div>
          {!supplementMode ? (
            currentMealAllocation ? (
              <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-sky-950">
                      {mealLabels[mealType]}当前剩余
                    </p>
                    <p className="mt-1 text-xs leading-5 text-sky-700">
                      推荐只计算已选食物的摄入量，不推荐食物种类。
                    </p>
                  </div>
                  <button
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
                    onClick={handleRecommendAmount}
                    type="button"
                  >
                    <Sparkles className="size-4" />
                    推荐摄入量
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
                  {(
                    [
                      ['热量', currentMealAllocation.remaining.calories, 'kcal'],
                      ['蛋白质', currentMealAllocation.remaining.protein, 'g'],
                      ['碳水', currentMealAllocation.remaining.carbs, 'g'],
                      ['脂肪', currentMealAllocation.remaining.fat, 'g'],
                    ] as const
                  ).map(([label, value, unit]) => (
                    <div className="rounded-lg bg-white px-2 py-2" key={label}>
                      <p className="text-sky-600">{label}</p>
                      <p
                        className={`mt-1 font-semibold ${value < 0 ? 'text-red-600' : 'text-sky-950'}`}
                      >
                        {formatNutrition(value, 1)} {unit}
                      </p>
                    </div>
                  ))}
                </div>
                {recommendationFeedback ? (
                  <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700">
                    {recommendationFeedback}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                加餐没有独立目标，其营养会从尚未记录的正餐额度中扣除。
              </p>
            )
          ) : null}
          {preview ? (
            <div className="grid grid-cols-4 gap-3 rounded-xl bg-emerald-50 p-4 text-center">
              {[
                ['热量', preview.calories, 'kcal'],
                ['蛋白质', preview.protein, 'g'],
                ['碳水', preview.carbs, 'g'],
                ['脂肪', preview.fat, 'g'],
              ].map(([label, value, unit]) => (
                <div key={String(label)}>
                  <p className="text-xs text-emerald-700">{label}</p>
                  <p className="mt-1 font-semibold text-emerald-950">
                    {formatNutrition(Number(value), 1)} {unit}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
          <Field label="备注">
            <TextInput
              maxLength={300}
              onChange={(event) => setNote(event.target.value)}
              placeholder="可留空"
              value={note}
            />
          </Field>
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
            <button className={primaryButtonClass} disabled={submitting} type="submit">
              {submitting
                ? supplementMode
                  ? '正在记录…'
                  : '正在添加…'
                : supplementMode
                  ? '记录补剂'
                  : `加入${mealLabels[mealType]}`}
            </button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}

interface EditMealRecordDialogProps {
  record: MealRecord | null;
  onClose: () => void;
}

export function EditMealRecordDialog({ record, onClose }: EditMealRecordDialogProps) {
  const supplementMode = record?.mealType === 'supplement';
  const updateMealRecord = useAppStore((state) => state.updateMealRecord);
  const [amount, setAmount] = useState('');
  const [unitType, setUnitType] = useState<UnitType>('gram');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!record) return;
    setAmount(normalizeMealAmountInput(record.amount.toString(), record.unitType));
    setUnitType(record.unitType);
    setNote(record.note);
    setError(null);
  }, [record]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record) return;
    const parsedAmount = Number(amount);
    const normalizedAmount = normalizeMealAmountValue(parsedAmount, unitType);
    if (!isMealAmountValid(normalizedAmount)) {
      setError(
        unitType === 'gram'
          ? `${supplementMode ? '服用量' : '食用重量'}必须是大于或等于 0.1 的数字`
          : `${supplementMode ? '服用份数' : '份数'}必须是大于或等于 0.1 的数字`,
      );
      return;
    }
    if (unitType === 'serving' && !record.defaultServingGramsSnapshot) {
      setError('该历史记录没有有效的每份重量，请改用按克记录');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updateMealRecord({
        id: record.id,
        amount: normalizedAmount,
        unitType,
        note: note.trim(),
      });
      onClose();
    } catch (updateError) {
      setError(getErrorMessage(updateError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      closeDisabled={submitting}
      onClose={onClose}
      open={Boolean(record)}
      title={supplementMode ? '编辑补剂记录' : '编辑食物记录'}
      widthClassName="max-w-lg"
    >
      {record ? (
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="font-semibold text-slate-900">{record.foodNameSnapshot}</p>
            <p className="mt-1 text-sm text-slate-500">
              {record.brandSnapshot || record.categorySnapshot}
            </p>
          </div>
          {record.amountMode === 'recommended' ? (
            <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-700">
              当前为自动推荐量；保存手动修改后，该记录将固定为手动用量，不再自动调整。
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <Field label="记录方式">
              <SelectInput
                onChange={(event) => {
                  const nextUnit = event.target.value as UnitType;
                  setUnitType(nextUnit);
                  setAmount(nextUnit === 'serving' ? '1' : normalizeMealAmountInput('100', 'gram'));
                }}
                value={unitType}
              >
                <option value="gram">按克记录</option>
                <option disabled={!record.defaultServingGramsSnapshot} value="serving">
                  按{record.servingUnitNameSnapshot || '份'}记录
                  {record.defaultServingGramsSnapshot
                    ? `（每${record.servingUnitNameSnapshot || '份'} ${record.defaultServingGramsSnapshot}g）`
                    : '（未保存份量）'}
                </option>
              </SelectInput>
            </Field>
            <Field
              label={
                unitType === 'gram'
                  ? supplementMode
                    ? '服用量 (g)'
                    : '食用重量 (g)'
                  : `${supplementMode ? '服用份数' : '数量'} (${record.servingUnitNameSnapshot || '份'})`
              }
            >
              <MealAmountInput
                aria-label="食物数量"
                autoFocus
                disabled={submitting}
                onValueChange={setAmount}
                unitName={record.servingUnitNameSnapshot}
                unitType={unitType}
                value={amount}
              />
            </Field>
          </div>
          <Field label="备注">
            <TextInput
              maxLength={300}
              onChange={(event) => setNote(event.target.value)}
              value={note}
            />
          </Field>
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
            <button className={primaryButtonClass} disabled={submitting} type="submit">
              {submitting ? '保存中…' : '保存修改'}
            </button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}
