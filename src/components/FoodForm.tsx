import { useEffect, useState, type FormEvent } from 'react';

import { getErrorMessage } from '../services/api';
import { FOOD_CATEGORIES, type Food, type FoodCategory, type FoodInput } from '../types/models';
import {
  isMealAmountValid,
  normalizeMealAmountInput,
  normalizeMealAmountValue,
} from '../utils/meal-amount';
import {
  SUPPLEMENT_WEEKDAYS,
  supplementWeekdayLabels,
  type SupplementWeekday,
} from '../utils/supplements';
import {
  Field,
  primaryButtonClass,
  secondaryButtonClass,
  SelectInput,
  TextInput,
} from './ui/FormControls';
import { EnergyInput } from './EnergyInput';
import { MealAmountInput } from './ui/MealAmountInput';

interface FoodFormProps {
  initialFood?: Food | null;
  initialName?: string;
  kind?: 'food' | 'supplement';
  submitLabel?: string;
  onSubmit: (input: FoodInput) => Promise<void>;
  onSubmittingChange?: (submitting: boolean) => void;
  onCancel: () => void;
}

interface FoodFormState {
  name: string;
  brand: string;
  category: FoodCategory;
  caloriesPer100g: string;
  proteinPer100g: string;
  carbsPer100g: string;
  fatPer100g: string;
  defaultServingGrams: string;
  unitName: string;
  countInNutrition: boolean;
  isFavorite: boolean;
  isRecommendable: boolean;
  supplementFrequency: Food['supplementFrequency'];
  supplementWeekdays: Food['supplementWeekdays'];
  supplementDosage: string;
  supplementDosageUnit: Food['supplementDosageUnit'];
  note: string;
}

const REGULAR_FOOD_CATEGORIES = FOOD_CATEGORIES.filter(
  (category): category is Exclude<FoodCategory, '补剂'> => category !== '补剂',
);

function createFormState(
  food: Food | null | undefined,
  initialName: string,
  kind: 'food' | 'supplement',
): FoodFormState {
  const supplementMode = kind === 'supplement';
  return {
    name: food?.name ?? initialName,
    brand: food?.brand ?? '',
    category: supplementMode
      ? '补剂'
      : food?.category === '补剂'
        ? '其他'
        : (food?.category ?? '其他'),
    caloriesPer100g: String(food?.caloriesPer100g ?? 0),
    proteinPer100g: String(food?.proteinPer100g ?? 0),
    carbsPer100g: String(food?.carbsPer100g ?? 0),
    fatPer100g: String(food?.fatPer100g ?? 0),
    defaultServingGrams:
      food?.defaultServingGrams === null || food?.defaultServingGrams === undefined
        ? ''
        : String(food.defaultServingGrams),
    unitName: food?.unitName ?? '份',
    // 新增补剂先保持零营养且不计入，避免把尚未按包装填写的数据算进当天摄入。
    countInNutrition: food?.countInNutrition ?? !supplementMode,
    isFavorite: food?.isFavorite ?? false,
    isRecommendable: supplementMode ? false : (food?.isRecommendable ?? true),
    supplementFrequency: food?.supplementFrequency ?? 'as_needed',
    supplementWeekdays: food?.supplementWeekdays ?? [],
    supplementDosage:
      food?.supplementDosage === null || food?.supplementDosage === undefined
        ? ''
        : normalizeMealAmountInput(
            String(food.supplementDosage),
            food.supplementDosageUnit ?? 'gram',
          ),
    supplementDosageUnit: food?.supplementDosageUnit ?? 'gram',
    note: food?.note ?? '',
  };
}

export function FoodForm({
  initialFood,
  initialName,
  kind = 'food',
  submitLabel = '保存食物',
  onSubmit,
  onSubmittingChange,
  onCancel,
}: FoodFormProps) {
  const [form, setForm] = useState(() => createFormState(initialFood, initialName ?? '', kind));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const supplementMode = kind === 'supplement';

  useEffect(() => {
    setForm(createFormState(initialFood, initialName ?? '', kind));
    setError(null);
  }, [initialFood, initialName, kind]);

  function update<K extends keyof FoodFormState>(key: K, value: FoodFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = form.name.trim();
    const nutritionValues = [
      form.caloriesPer100g,
      form.proteinPer100g,
      form.carbsPer100g,
      form.fatPer100g,
    ].map(Number);
    const servingGrams = form.defaultServingGrams ? Number(form.defaultServingGrams) : null;
    const parsedSupplementDosage = form.supplementDosage.trim()
      ? Number(form.supplementDosage)
      : null;
    const supplementDosage =
      parsedSupplementDosage === null
        ? null
        : normalizeMealAmountValue(parsedSupplementDosage, form.supplementDosageUnit);

    if (!name) {
      setError(`${supplementMode ? '补剂' : '食物'}名称不能为空`);
      return;
    }
    if (nutritionValues.some((value) => !Number.isFinite(value) || value < 0)) {
      setError('每 100 克营养数据必须是大于或等于 0 的数字');
      return;
    }
    if (servingGrams !== null && (!Number.isFinite(servingGrams) || servingGrams <= 0)) {
      setError('默认每份重量必须大于 0，或留空');
      return;
    }
    if (supplementMode && supplementDosage !== null && !isMealAmountValid(supplementDosage)) {
      setError(
        form.supplementDosageUnit === 'gram'
          ? '每次用量必须是大于或等于 0.1 的数字，或在按需服用时留空'
          : '每次份数必须是大于或等于 0.1 的数字，或在按需服用时留空',
      );
      return;
    }
    if (
      supplementMode &&
      form.supplementFrequency === 'weekdays' &&
      form.supplementWeekdays.length === 0
    ) {
      setError('每周指定日服用时，请至少选择一天');
      return;
    }
    if (supplementMode && form.supplementFrequency !== 'as_needed' && supplementDosage === null) {
      // 自动生成当日计划必须有确定用量，按需补剂允许只保留说明。
      setError('每天或每周指定日服用时，必须填写每次用量');
      return;
    }
    if (
      supplementMode &&
      supplementDosage !== null &&
      form.supplementDosageUnit === 'serving' &&
      servingGrams === null
    ) {
      setError('按份设置用量前，必须填写默认每份重量');
      return;
    }

    setSubmitting(true);
    onSubmittingChange?.(true);
    setError(null);
    try {
      await onSubmit({
        name,
        brand: form.brand.trim(),
        category: supplementMode ? '补剂' : form.category,
        caloriesPer100g: nutritionValues[0],
        proteinPer100g: nutritionValues[1],
        carbsPer100g: nutritionValues[2],
        fatPer100g: nutritionValues[3],
        defaultServingGrams: servingGrams,
        unitName: form.unitName.trim() || '份',
        isSupplement: supplementMode,
        countInNutrition: form.countInNutrition,
        isFavorite: form.isFavorite,
        isRecommendable: supplementMode ? false : form.isRecommendable,
        supplementFrequency: supplementMode ? form.supplementFrequency : 'as_needed',
        supplementWeekdays: supplementMode
          ? SUPPLEMENT_WEEKDAYS.filter((weekday) => form.supplementWeekdays.includes(weekday))
          : [],
        supplementDosage: supplementMode ? supplementDosage : null,
        supplementDosageUnit: supplementMode ? form.supplementDosageUnit : 'gram',
        note: form.note.trim(),
      });
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      setSubmitting(false);
      onSubmittingChange?.(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      {error ? (
        <div
          aria-live="polite"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <Field label={`${supplementMode ? '补剂' : '食物'}名称 *`}>
          <TextInput
            autoFocus
            maxLength={80}
            onChange={(event) => update('name', event.target.value)}
            value={form.name}
          />
        </Field>
        <Field label="品牌">
          <TextInput
            maxLength={80}
            onChange={(event) => update('brand', event.target.value)}
            placeholder="可留空"
            value={form.brand}
          />
        </Field>
        <Field label="分类 *">
          {supplementMode ? (
            <SelectInput disabled value="补剂">
              <option>补剂</option>
            </SelectInput>
          ) : (
            <SelectInput
              onChange={(event) => update('category', event.target.value as FoodCategory)}
              value={form.category}
            >
              {REGULAR_FOOD_CATEGORIES.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </SelectInput>
          )}
        </Field>
        <Field label="份量单位" hint="例如：份、个、粒、杯">
          <TextInput
            maxLength={12}
            onChange={(event) => update('unitName', event.target.value)}
            value={form.unitName}
          />
        </Field>
      </div>

      {supplementMode ? (
        <fieldset className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
          <legend className="px-1 text-sm font-semibold text-slate-900">服用计划</legend>
          <div className="grid grid-cols-3 gap-4">
            <Field label="服用频率">
              <SelectInput
                onChange={(event) =>
                  update('supplementFrequency', event.target.value as Food['supplementFrequency'])
                }
                value={form.supplementFrequency}
              >
                <option value="as_needed">按需服用</option>
                <option value="daily">每天</option>
                <option value="weekdays">每周指定日</option>
              </SelectInput>
            </Field>
            <Field
              hint={form.supplementFrequency === 'as_needed' ? '按需服用时可以留空' : undefined}
              label="每次用量"
            >
              <MealAmountInput
                aria-label="每次用量"
                disabled={submitting}
                onValueChange={(value) => update('supplementDosage', value)}
                placeholder={form.supplementFrequency === 'as_needed' ? '可留空' : '必填'}
                required={form.supplementFrequency !== 'as_needed'}
                unitName={form.unitName}
                unitType={form.supplementDosageUnit}
                value={form.supplementDosage}
              />
            </Field>
            <Field label="用量单位">
              <SelectInput
                onChange={(event) =>
                  update('supplementDosageUnit', event.target.value as Food['supplementDosageUnit'])
                }
                value={form.supplementDosageUnit}
              >
                <option value="gram">克 (g)</option>
                <option value="serving">{form.unitName || '份'}</option>
              </SelectInput>
            </Field>
          </div>
          {form.supplementFrequency === 'weekdays' ? (
            <div className="mt-4">
              <p className="text-sm font-medium text-slate-700">服用日期</p>
              <div className="mt-2 grid grid-cols-7 gap-2">
                {SUPPLEMENT_WEEKDAYS.map((weekday) => {
                  const checked = form.supplementWeekdays.includes(weekday);
                  return (
                    <label
                      className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-sm transition ${
                        checked
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                      key={weekday}
                    >
                      <input
                        checked={checked}
                        className="size-4 accent-emerald-600"
                        onChange={(event) => {
                          const nextWeekdays = event.target.checked
                            ? [...form.supplementWeekdays, weekday]
                            : form.supplementWeekdays.filter((value) => value !== weekday);
                          update('supplementWeekdays', nextWeekdays as SupplementWeekday[]);
                        }}
                        type="checkbox"
                      />
                      {supplementWeekdayLabels[weekday]}
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
          {form.supplementDosageUnit === 'serving' && !form.defaultServingGrams ? (
            <p className="mt-3 text-xs text-amber-700">
              按份记录需要在下方填写“默认每份重量”，用于换算营养数据。
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <fieldset>
        <legend className="mb-1 text-sm font-semibold text-slate-900">每 100 克营养</legend>
        {supplementMode ? (
          <p className="mb-3 text-xs leading-5 text-slate-500">
            新增时四项默认为
            0。鱼油、蛋白粉等请根据本人购买产品的包装标签填写，应用不会套用通用营养值。
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <EnergyInput
            initialUnit={!initialFood && !supplementMode ? 'kJ' : 'kcal'}
            label="热量"
            onValueKcalChange={(value) => update('caloriesPer100g', value)}
            required
            valueKcal={form.caloriesPer100g}
          />
          <Field label="蛋白质 (g)">
            <TextInput
              min="0"
              onChange={(event) => update('proteinPer100g', event.target.value)}
              required
              step="0.0001"
              type="number"
              value={form.proteinPer100g}
            />
          </Field>
          <Field label="碳水 (g)">
            <TextInput
              min="0"
              onChange={(event) => update('carbsPer100g', event.target.value)}
              required
              step="0.0001"
              type="number"
              value={form.carbsPer100g}
            />
          </Field>
          <Field label="脂肪 (g)">
            <TextInput
              min="0"
              onChange={(event) => update('fatPer100g', event.target.value)}
              required
              step="0.0001"
              type="number"
              value={form.fatPer100g}
            />
          </Field>
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-4">
        <Field label="默认每份重量 (g)" hint="按份记录前必须填写">
          <TextInput
            min="0.0001"
            onChange={(event) => update('defaultServingGrams', event.target.value)}
            placeholder="可留空"
            step="0.0001"
            type="number"
            value={form.defaultServingGrams}
          />
        </Field>
        <Field label={supplementMode ? '主要作用 / 说明' : '备注'}>
          <textarea
            className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15"
            maxLength={300}
            onChange={(event) => update('note', event.target.value)}
            placeholder={supplementMode ? '记录主要作用、服用说明或注意事项' : '可留空'}
            value={form.note}
          />
        </Field>
      </div>

      <div
        className={`grid gap-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-700 ${
          supplementMode ? 'grid-cols-2' : 'grid-cols-3'
        }`}
      >
        <label className="flex items-center gap-2">
          <input
            checked={form.countInNutrition}
            className="size-4 accent-emerald-600"
            onChange={(event) => update('countInNutrition', event.target.checked)}
            type="checkbox"
          />
          计入营养统计
        </label>
        <label className="flex items-center gap-2">
          <input
            checked={form.isFavorite}
            className="size-4 accent-emerald-600"
            onChange={(event) => update('isFavorite', event.target.checked)}
            type="checkbox"
          />
          标记为常用
        </label>
        {!supplementMode ? (
          <label className="flex items-center gap-2">
            <input
              checked={form.isRecommendable}
              className="size-4 accent-emerald-600"
              onChange={(event) => update('isRecommendable', event.target.checked)}
              type="checkbox"
            />
            可用于后续推荐
          </label>
        ) : null}
      </div>
      {supplementMode ? (
        <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          “计入营养统计”由你决定。开启前请先补全实际产品的营养数据；关闭后仍会保存服用记录，但不会累加到当天碳水、蛋白质、脂肪和热量。
        </p>
      ) : null}

      <div className="flex justify-end gap-3 border-t border-slate-200 pt-5">
        <button
          className={secondaryButtonClass}
          disabled={submitting}
          onClick={onCancel}
          type="button"
        >
          取消
        </button>
        <button className={primaryButtonClass} disabled={submitting} type="submit">
          {submitting ? '正在保存…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
