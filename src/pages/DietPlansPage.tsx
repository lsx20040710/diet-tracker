import { Check, Copy, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { EnergyInput } from '../components/EnergyInput';
import { DietPlanVariantsDialog } from '../components/DietPlanVariantsDialog';
import { WeightBasedTargetControls } from '../components/WeightBasedTargetControls';
import {
  Field,
  primaryButtonClass,
  secondaryButtonClass,
  SelectInput,
  TextInput,
} from '../components/ui/FormControls';
import { Modal } from '../components/ui/Modal';
import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { confirmAction } from '../stores/confirmation-store';
import { useAppStore } from '../stores/app-store';
import {
  DEFAULT_MEAL_RATIOS,
  GOAL_TYPES,
  type BodyRecord,
  type DietPlan,
  type DietPlanInput,
  type DietPlanVariant,
  type DietPlanWeightSourceMode,
  type GoalType,
  type NutritionTarget,
} from '../types/models';
import { todayString } from '../utils/date';
import {
  calculateWeightBasedPlan,
  DEFAULT_CARBS_PER_KG,
  DEFAULT_FAT_PER_KG,
  DEFAULT_PROTEIN_PER_KG,
  getValidWeightRecords,
} from '../utils/diet-plan';
import { formatNutrition } from '../utils/nutrition';

type PlanDialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; plan: DietPlan }
  | { mode: 'copy'; plan: DietPlan };

interface PlanFormProps {
  state: Exclude<PlanDialogState, { mode: 'closed' }>;
  bodyRecords: BodyRecord[];
  hasDayPlans: boolean;
  onCancel: () => void;
  onSubmit: (input: DietPlanInput) => Promise<void>;
  onSubmittingChange: (submitting: boolean) => void;
}

function parseNumberInput(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function formatWeightSource(
  source: Pick<DietPlan, 'weightSourceMode' | 'calculationWeight' | 'weightSourceDate'>,
): string {
  if (source.calculationWeight === null) {
    return source.weightSourceMode === 'latest'
      ? '自动跟随最新体重（等待有效记录）'
      : '手动体重未填写';
  }
  const weight = formatNutrition(source.calculationWeight, 2) + ' kg';
  return source.weightSourceMode === 'latest'
    ? '自动跟随最新体重：' + (source.weightSourceDate ?? '日期未知') + ' · ' + weight
    : '手动输入体重：' + weight;
}

function PlanForm({
  state,
  bodyRecords,
  hasDayPlans,
  onCancel,
  onSubmit,
  onSubmittingChange,
}: PlanFormProps) {
  const source = state.mode === 'create' ? null : state.plan;
  const validWeightRecords = useMemo(() => getValidWeightRecords(bodyRecords), [bodyRecords]);
  const latestWeightRecord = validWeightRecords[0] ?? null;
  const [name, setName] = useState(
    state.mode === 'copy' ? `${source?.name ?? ''} 副本` : (source?.name ?? ''),
  );
  const [goalType, setGoalType] = useState<GoalType>(source?.goalType ?? '自定义');
  const [calculationMode, setCalculationMode] = useState<'manual' | 'weight_based'>(
    source?.calculationMode ?? 'manual',
  );
  const [weightSourceMode, setWeightSourceMode] = useState<DietPlanWeightSourceMode>(
    source?.calculationMode === 'weight_based' ? source.weightSourceMode : 'latest',
  );
  const [calculationWeight, setCalculationWeight] = useState<number | null>(
    source?.calculationWeight ?? latestWeightRecord?.weight ?? null,
  );
  const [proteinPerKg, setProteinPerKg] = useState(
    String(source?.proteinPerKg ?? DEFAULT_PROTEIN_PER_KG),
  );
  const [carbsPerKg, setCarbsPerKg] = useState(String(source?.carbsPerKg ?? DEFAULT_CARBS_PER_KG));
  const [fatPerKg, setFatPerKg] = useState(String(source?.fatPerKg ?? DEFAULT_FAT_PER_KG));
  const [calories, setCalories] = useState(String(source?.calories ?? 2000));
  const [protein, setProtein] = useState(String(source?.protein ?? 120));
  const [carbs, setCarbs] = useState(String(source?.carbs ?? 250));
  const [fat, setFat] = useState(String(source?.fat ?? 60));
  const [breakfastRatio, setBreakfastRatio] = useState(
    String(source?.mealRatios.breakfast ?? DEFAULT_MEAL_RATIOS.breakfast),
  );
  const [lunchRatio, setLunchRatio] = useState(
    String(source?.mealRatios.lunch ?? DEFAULT_MEAL_RATIOS.lunch),
  );
  const [dinnerRatio, setDinnerRatio] = useState(
    String(source?.mealRatios.dinner ?? DEFAULT_MEAL_RATIOS.dinner),
  );
  const [startDate, setStartDate] = useState(source?.startDate ?? todayString());
  const [endDate, setEndDate] = useState(source?.endDate ?? '');
  const [note, setNote] = useState(source?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const effectiveCalculationWeight =
    weightSourceMode === 'latest' ? (latestWeightRecord?.weight ?? null) : calculationWeight;
  const effectiveWeightSourceDate =
    weightSourceMode === 'latest' ? (latestWeightRecord?.recordDate ?? null) : null;

  const applyWeightBasedTarget = useCallback((target: NutritionTarget) => {
    setCalories(String(target.calories));
    setProtein(String(target.protein));
    setCarbs(String(target.carbs));
    setFat(String(target.fat));
    setError(null);
  }, []);

  const macroCalories = useMemo(() => {
    const values = [protein, carbs, fat].map(parseNumberInput);
    if (values.some((value) => !Number.isFinite(value))) return null;
    return values[0] * 4 + values[1] * 4 + values[2] * 9;
  }, [carbs, fat, protein]);
  const targetCalories = parseNumberInput(calories);
  const calorieDifference =
    macroCalories === null || !Number.isFinite(targetCalories)
      ? null
      : macroCalories - targetCalories;
  const shouldWarn =
    calorieDifference !== null &&
    Math.abs(calorieDifference) > Math.max(100, Math.abs(targetCalories) * 0.1);
  const targetsManagedByDayPlans = state.mode !== 'create' && hasDayPlans;
  const parsedMealRatios = [breakfastRatio, lunchRatio, dinnerRatio].map(parseNumberInput);
  const mealRatioTotal = parsedMealRatios.reduce(
    (sum, value) => (Number.isFinite(value) ? sum + value : sum),
    0,
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    const parsed = [calories, protein, carbs, fat].map(parseNumberInput);
    if (!name.trim()) {
      setError('方案名称不能为空');
      return;
    }
    if (parsed.some((value) => !Number.isFinite(value) || value < 0)) {
      setError('目标数据必须是大于或等于 0 的数字');
      return;
    }
    if (
      parsedMealRatios.some((value) => !Number.isFinite(value) || value < 0 || value > 1_000) ||
      mealRatioTotal <= 0
    ) {
      setError('早、中、晚餐比例必须是 0 到 1000 之间的数字，且不能全部为 0');
      return;
    }
    if (!startDate) {
      setError('请选择开始日期');
      return;
    }
    if (endDate && endDate < startDate) {
      setError('结束日期不能早于开始日期');
      return;
    }

    const parsedProteinPerKg = parseNumberInput(proteinPerKg);
    const parsedCarbsPerKg = parseNumberInput(carbsPerKg);
    const parsedFatPerKg = parseNumberInput(fatPerKg);
    try {
      if (calculationMode === 'weight_based') {
        calculateWeightBasedPlan({
          weight: effectiveCalculationWeight ?? Number.NaN,
          proteinPerKg: parsedProteinPerKg,
          carbsPerKg: parsedCarbsPerKg,
          fatPerKg: parsedFatPerKg,
        });
      }
    } catch (calculationError) {
      setError(getErrorMessage(calculationError));
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    onSubmittingChange(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        goalType,
        targetCalories: parsed[0],
        targetProtein: parsed[1],
        targetCarbs: parsed[2],
        targetFat: parsed[3],
        mealRatios: {
          breakfast: parsedMealRatios[0],
          lunch: parsedMealRatios[1],
          dinner: parsedMealRatios[2],
        },
        calculationMode,
        weightSourceMode: calculationMode === 'weight_based' ? weightSourceMode : 'latest',
        calculationWeight: calculationMode === 'weight_based' ? effectiveCalculationWeight : null,
        weightSourceDate: calculationMode === 'weight_based' ? effectiveWeightSourceDate : null,
        proteinPerKg: calculationMode === 'weight_based' ? parsedProteinPerKg : null,
        carbsPerKg: calculationMode === 'weight_based' ? parsedCarbsPerKg : null,
        fatPerKg: calculationMode === 'weight_based' ? parsedFatPerKg : null,
        startDate,
        endDate: endDate || null,
        note: note.trim(),
      });
    } catch (submitError) {
      setError(getErrorMessage(submitError));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      onSubmittingChange(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      {error ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <Field label="方案名称 *">
          <TextInput
            autoFocus
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Field>
        <Field label="目标类型 *">
          <SelectInput
            onChange={(event) => setGoalType(event.target.value as GoalType)}
            value={goalType}
          >
            {GOAL_TYPES.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </SelectInput>
        </Field>
      </div>

      {targetsManagedByDayPlans ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm leading-6 text-emerald-800">
          此方案的营养目标按日型分别设置。训练日、休息日各自采用的体重和三项系数，请在方案卡片的“管理日型”中编辑。
        </div>
      ) : (
        <>
          <fieldset>
            <legend className="text-sm font-semibold text-slate-900">每日目标</legend>
            <div className="mt-3">
              <WeightBasedTargetControls
                bodyRecords={bodyRecords}
                calculationMode={calculationMode}
                calculationWeight={calculationWeight}
                carbsPerKg={carbsPerKg}
                fatPerKg={fatPerKg}
                onApplyTarget={applyWeightBasedTarget}
                onCalculationModeChange={(mode) => {
                  setCalculationMode(mode);
                  if (mode === 'weight_based') setWeightSourceMode('latest');
                }}
                onCalculationWeightChange={setCalculationWeight}
                onCarbsPerKgChange={setCarbsPerKg}
                onFatPerKgChange={setFatPerKg}
                onProteinPerKgChange={setProteinPerKg}
                onWeightSourceModeChange={setWeightSourceMode}
                proteinPerKg={proteinPerKg}
                weightSourceMode={weightSourceMode}
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <EnergyInput
                label="热量"
                onValueKcalChange={setCalories}
                required
                valueKcal={calories}
              />
              <Field label="蛋白质 (g)">
                <TextInput
                  min="0"
                  onChange={(event) => setProtein(event.target.value)}
                  required
                  step="any"
                  type="number"
                  value={protein}
                />
              </Field>
              <Field label="碳水 (g)">
                <TextInput
                  min="0"
                  onChange={(event) => setCarbs(event.target.value)}
                  required
                  step="any"
                  type="number"
                  value={carbs}
                />
              </Field>
              <Field label="脂肪 (g)">
                <TextInput
                  min="0"
                  onChange={(event) => setFat(event.target.value)}
                  required
                  step="any"
                  type="number"
                  value={fat}
                />
              </Field>
            </div>
          </fieldset>

          {macroCalories !== null ? (
            <div
              className={`rounded-lg px-4 py-3 text-sm ${shouldWarn ? 'border border-amber-200 bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-600'}`}
            >
              三大营养素换算热量为 {formatNutrition(macroCalories, 1)} kcal
              {calorieDifference !== null
                ? `，与总热量相差 ${formatNutrition(Math.abs(calorieDifference), 1)} kcal`
                : ''}
              。{shouldWarn ? ' 差距较大，但仍允许按当前数据保存。' : ''}
            </div>
          ) : null}
        </>
      )}

      <fieldset className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-900">早中晚餐分配比例</legend>
        <p className="mb-3 text-xs leading-5 text-slate-500">
          热量和三大营养素共用这组比例；前一餐超额会自动挤占后续餐次。
        </p>
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              ['早餐', breakfastRatio, setBreakfastRatio],
              ['午餐', lunchRatio, setLunchRatio],
              ['晚餐', dinnerRatio, setDinnerRatio],
            ] as const
          ).map(([label, value, setter]) => (
            <Field
              hint={
                mealRatioTotal > 0 && Number.isFinite(Number(value))
                  ? `${((Number(value) / mealRatioTotal) * 100).toFixed(1)}%`
                  : undefined
              }
              key={label}
              label={label}
            >
              <TextInput
                min="0"
                onChange={(event) => setter(event.target.value)}
                required
                step="0.1"
                type="number"
                value={value}
              />
            </Field>
          ))}
        </div>
        <p className="mt-3 text-xs font-medium text-emerald-700">
          当前比例：{breakfastRatio || '0'} : {lunchRatio || '0'} : {dinnerRatio || '0'}
        </p>
      </fieldset>

      <div className="grid grid-cols-2 gap-4">
        <Field label="开始日期 *">
          <TextInput
            onChange={(event) => setStartDate(event.target.value)}
            required
            type="date"
            value={startDate}
          />
        </Field>
        <Field label="结束日期" hint="不填写表示长期使用">
          <TextInput
            min={startDate}
            onChange={(event) => setEndDate(event.target.value)}
            type="date"
            value={endDate}
          />
        </Field>
      </div>
      <Field label="备注">
        <textarea
          className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15"
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
          placeholder="可留空"
          value={note}
        />
      </Field>
      <p className="text-xs text-slate-500">目标估算仅供饮食记录与规划参考，不属于医疗建议。</p>
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
          {submitting ? '正在保存…' : '保存方案'}
        </button>
      </div>
    </form>
  );
}

export function DietPlansPage() {
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const beginSaving = useAppStore((state) => state.beginSaving);
  const finishSaving = useAppStore((state) => state.finishSaving);
  const reportSaveError = useAppStore((state) => state.reportSaveError);
  const [plans, setPlans] = useState<DietPlan[]>([]);
  const [variantsByPlanId, setVariantsByPlanId] = useState<Record<number, DietPlanVariant[]>>({});
  const [bodyRecords, setBodyRecords] = useState<BodyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<PlanDialogState>({ mode: 'closed' });
  const [planSubmitting, setPlanSubmitting] = useState(false);
  const [variantPlan, setVariantPlan] = useState<DietPlan | null>(null);
  const [mutatingPlanId, setMutatingPlanId] = useState<number | null>(null);
  const loadRequestIdRef = useRef(0);
  const planMutationRef = useRef(false);

  const loadPageData = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const api = getDietTrackerApi();
      const [loadedPlans, loadedBodyRecords] = await Promise.all([
        api.listDietPlans(),
        api.listBodyRecords(),
      ]);
      const nextPlans = unwrapApiResult(loadedPlans);
      const loadedVariantLists = await Promise.all(
        nextPlans.map(async (plan) => ({
          planId: plan.id,
          variants: unwrapApiResult(await api.listDietPlanVariants(plan.id)),
        })),
      );
      if (requestId !== loadRequestIdRef.current) return;
      setPlans(nextPlans);
      setVariantsByPlanId(
        Object.fromEntries(loadedVariantLists.map(({ planId, variants }) => [planId, variants])),
      );
      setBodyRecords(unwrapApiResult(loadedBodyRecords));
    } catch (loadError) {
      if (requestId === loadRequestIdRef.current) setError(getErrorMessage(loadError));
    } finally {
      if (requestId === loadRequestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPageData();
  }, [loadPageData]);

  async function savePlan(input: DietPlanInput) {
    beginSaving();
    try {
      if (dialog.mode === 'edit') {
        unwrapApiResult(await getDietTrackerApi().updateDietPlan(dialog.plan.id, input));
      } else if (dialog.mode === 'copy') {
        // 方案与日型在同一数据库事务内复制，失败时不会留下不完整副本。
        unwrapApiResult(await getDietTrackerApi().duplicateDietPlan(dialog.plan.id, input));
      } else {
        unwrapApiResult(await getDietTrackerApi().createDietPlan(input));
      }
      setDialog({ mode: 'closed' });
      await Promise.all([loadPageData(), loadDashboard()]);
      finishSaving();
    } catch (saveError) {
      reportSaveError(getErrorMessage(saveError));
      throw saveError;
    }
  }

  async function activatePlan(plan: DietPlan) {
    if (plan.isActive || planMutationRef.current) return;
    planMutationRef.current = true;
    setMutatingPlanId(plan.id);
    setError(null);
    beginSaving();
    try {
      unwrapApiResult(await getDietTrackerApi().activateDietPlan(plan.id));
      await Promise.all([loadPageData(), loadDashboard()]);
      finishSaving();
    } catch (activateError) {
      const message = getErrorMessage(activateError);
      setError(message);
      reportSaveError(message);
    } finally {
      planMutationRef.current = false;
      setMutatingPlanId(null);
    }
  }

  async function deletePlan(plan: DietPlan) {
    if (planMutationRef.current) return;
    if (plan.isActive) {
      setError('当前方案不能删除，请先启用另一个方案');
      return;
    }
    if (!(await confirmAction(`确定删除饮食方案“${plan.name}”吗？`))) return;
    planMutationRef.current = true;
    setMutatingPlanId(plan.id);
    setError(null);
    beginSaving();
    try {
      unwrapApiResult(await getDietTrackerApi().deleteDietPlan(plan.id));
      await loadPageData();
      finishSaving();
    } catch (deleteError) {
      const message = getErrorMessage(deleteError);
      setError(message);
      reportSaveError(message);
    } finally {
      planMutationRef.current = false;
      setMutatingPlanId(null);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-[1500px] flex-col p-5">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">饮食方案</h1>
          <p className="mt-1 text-sm text-slate-500">
            一个方案可包含训练日、休息日或高低碳等日型，按日期快速切换当天目标。
          </p>
        </div>
        <button
          className={primaryButtonClass}
          disabled={mutatingPlanId !== null}
          onClick={() => setDialog({ mode: 'create' })}
          type="button"
        >
          <Plus className="size-4" />
          新建方案
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
          正在读取饮食方案…
        </div>
      ) : plans.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-sm text-slate-500">
          <p>还没有饮食方案，首页营养目标将显示为 0。</p>
          <button
            className="mt-3 font-medium text-emerald-700"
            disabled={mutatingPlanId !== null}
            onClick={() => setDialog({ mode: 'create' })}
            type="button"
          >
            创建第一个方案
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 overflow-y-auto pb-2 xl:grid-cols-3">
          {plans.map((plan) => {
            const planVariants = variantsByPlanId[plan.id] ?? [];
            return (
              <article
                className={`rounded-xl border bg-white p-5 shadow-sm ${plan.isActive ? 'border-emerald-400 ring-2 ring-emerald-100' : 'border-slate-200'}`}
                key={plan.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate font-semibold text-slate-900">{plan.name}</h2>
                      {plan.isActive ? (
                        <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          当前方案
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">{plan.goalType}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      aria-label={`编辑 ${plan.name}`}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      disabled={mutatingPlanId !== null}
                      onClick={() => setDialog({ mode: 'edit', plan })}
                      type="button"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      aria-label={`复制 ${plan.name}`}
                      className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      disabled={mutatingPlanId !== null}
                      onClick={() => setDialog({ mode: 'copy', plan })}
                      type="button"
                    >
                      <Copy className="size-4" />
                    </button>
                    <button
                      aria-label={`删除 ${plan.name}`}
                      className={`rounded-md p-1.5 ${plan.isActive ? 'cursor-not-allowed text-slate-300' : 'text-slate-400 hover:bg-red-50 hover:text-red-600'}`}
                      disabled={mutatingPlanId !== null || plan.isActive}
                      onClick={() => void deletePlan(plan)}
                      title={plan.isActive ? '请先启用其他方案' : '删除'}
                      type="button"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>

                <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-700">
                      <Tag className="size-4 shrink-0 text-emerald-600" />
                      日型计划
                      <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">
                        {planVariants.length}
                      </span>
                    </div>
                    <button
                      className="shrink-0 text-xs font-medium text-emerald-700 hover:underline"
                      disabled={mutatingPlanId !== null}
                      onClick={() => setVariantPlan(plan)}
                      type="button"
                    >
                      {planVariants.length > 0 ? '管理日型' : '添加日型'}
                    </button>
                  </div>
                  {planVariants.length ? (
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {planVariants.slice(0, 4).map((variant) => (
                        <div
                          className="rounded-lg border border-emerald-100 bg-white px-3 py-2"
                          key={variant.id}
                        >
                          <p className="truncate text-xs font-semibold text-emerald-800">
                            {variant.name}
                          </p>
                          <p className="mt-1 text-[11px] leading-5 text-slate-500">
                            {formatNutrition(variant.calories, 1)} kcal · 蛋白质{' '}
                            {formatNutrition(variant.protein, 1)} g · 碳水{' '}
                            {formatNutrition(variant.carbs, 1)} g · 脂肪{' '}
                            {formatNutrition(variant.fat, 1)} g
                          </p>
                          {variant.calculationMode === 'weight_based' ? (
                            <p className="mt-1 text-[11px] leading-5 text-emerald-700">
                              {formatWeightSource(variant)}；蛋白质{' '}
                              {formatNutrition(variant.proteinPerKg ?? 0, 2)}、碳水{' '}
                              {formatNutrition(variant.carbsPerKg ?? 0, 2)}、脂肪{' '}
                              {formatNutrition(variant.fatPerKg ?? 0, 2)} g/kg
                            </p>
                          ) : null}
                        </div>
                      ))}
                      {planVariants.length > 4 ? (
                        <p className="col-span-full text-xs text-slate-500">
                          另有 {planVariants.length - 4} 个日型，请进入管理查看。
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-3">
                      <p className="mb-2 text-xs text-slate-500">
                        尚未配置日型，当前暂按方案基础目标计算。
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          ['热量', plan.calories, 'kcal'],
                          ['蛋白质', plan.protein, 'g'],
                          ['碳水', plan.carbs, 'g'],
                          ['脂肪', plan.fat, 'g'],
                        ].map(([label, value, unit]) => (
                          <div className="rounded-lg bg-white px-3 py-2" key={String(label)}>
                            <p className="text-xs text-slate-500">{label}</p>
                            <p className="mt-1 font-semibold text-slate-900">
                              {formatNutrition(Number(value), 1)}{' '}
                              <span className="text-xs font-normal text-slate-500">{unit}</span>
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <p className="mt-4 text-xs text-slate-500">
                  {plan.startDate} 至 {plan.endDate || '长期'}
                </p>
                <p className="mt-2 text-xs font-medium text-emerald-700">
                  早中晚比例：{plan.mealRatios.breakfast} : {plan.mealRatios.lunch} :{' '}
                  {plan.mealRatios.dinner}
                </p>
                {planVariants.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">
                    {plan.calculationMode === 'weight_based' &&
                    plan.calculationWeight !== null &&
                    plan.proteinPerKg !== null &&
                    plan.carbsPerKg !== null &&
                    plan.fatPerKg !== null
                      ? '计算依据：' +
                        formatWeightSource(plan) +
                        '，蛋白质 × ' +
                        formatNutrition(plan.proteinPerKg, 2) +
                        '，碳水 × ' +
                        formatNutrition(plan.carbsPerKg, 2) +
                        '，脂肪 × ' +
                        formatNutrition(plan.fatPerKg, 2)
                      : '基础目标由用户手动填写'}
                  </p>
                ) : null}
                {plan.note ? (
                  <p className="mt-2 line-clamp-2 text-sm text-slate-600">{plan.note}</p>
                ) : null}
                {!plan.isActive ? (
                  <button
                    className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
                    disabled={mutatingPlanId !== null}
                    onClick={() => void activatePlan(plan)}
                    type="button"
                  >
                    <Check className="size-4" />
                    设为当前方案
                  </button>
                ) : (
                  <div className="mt-4 flex items-center justify-center gap-2 py-2 text-sm font-medium text-emerald-700">
                    <Check className="size-4" />
                    正在使用
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <Modal
        closeDisabled={planSubmitting}
        description={dialog.mode === 'copy' ? '方案及其全部日型计划会一起复制。' : undefined}
        onClose={() => {
          if (!planSubmitting) setDialog({ mode: 'closed' });
        }}
        open={dialog.mode !== 'closed'}
        title={
          dialog.mode === 'edit'
            ? '编辑饮食方案'
            : dialog.mode === 'copy'
              ? '复制饮食方案'
              : '新建饮食方案'
        }
        widthClassName="max-w-4xl"
      >
        {dialog.mode !== 'closed' ? (
          <PlanForm
            bodyRecords={bodyRecords}
            hasDayPlans={
              dialog.mode === 'create' ? false : (variantsByPlanId[dialog.plan.id]?.length ?? 0) > 0
            }
            onCancel={() => setDialog({ mode: 'closed' })}
            onSubmit={savePlan}
            onSubmittingChange={setPlanSubmitting}
            state={dialog}
          />
        ) : null}
      </Modal>

      <DietPlanVariantsDialog
        bodyRecords={bodyRecords}
        onClose={() => setVariantPlan(null)}
        onVariantsChange={(planId, variants) => {
          setVariantsByPlanId((current) => ({ ...current, [planId]: variants }));
        }}
        open={variantPlan !== null}
        plan={variantPlan}
        variants={variantPlan ? (variantsByPlanId[variantPlan.id] ?? []) : []}
      />
    </div>
  );
}
