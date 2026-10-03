import { Copy, Pencil, Plus, Tag, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { getDietTrackerApi, getErrorMessage, unwrapApiResult } from '../services/api';
import { useAppStore } from '../stores/app-store';
import type {
  BodyRecord,
  DietPlan,
  DietPlanCalculationMode,
  DietPlanVariant,
  DietPlanVariantUpdateInput,
  DietPlanWeightSourceMode,
  NutritionTarget,
} from '../types/models';
import {
  calculateWeightBasedPlan,
  DEFAULT_CARBS_PER_KG,
  DEFAULT_FAT_PER_KG,
  DEFAULT_PROTEIN_PER_KG,
  getValidWeightRecords,
} from '../utils/diet-plan';
import { formatNutrition } from '../utils/nutrition';
import { EnergyInput } from './EnergyInput';
import { Field, primaryButtonClass, secondaryButtonClass, TextInput } from './ui/FormControls';
import { Modal } from './ui/Modal';
import { WeightBasedTargetControls } from './WeightBasedTargetControls';

const VARIANT_NAME_SUGGESTIONS = ['训练日', '休息日', '高碳日', '低碳日'] as const;

type VariantFormState =
  | { mode: 'list' }
  | { mode: 'create' }
  | { mode: 'edit'; variant: DietPlanVariant }
  | { mode: 'copy'; variant: DietPlanVariant };

interface DietPlanVariantsDialogProps {
  open: boolean;
  plan: DietPlan | null;
  variants: DietPlanVariant[];
  bodyRecords: BodyRecord[];
  onClose: () => void;
  onVariantsChange: (planId: number, variants: DietPlanVariant[]) => void;
}

interface VariantFormProps {
  plan: DietPlan;
  state: Exclude<VariantFormState, { mode: 'list' }>;
  variants: DietPlanVariant[];
  bodyRecords: BodyRecord[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (input: DietPlanVariantUpdateInput) => Promise<void>;
}

function parseTarget(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function formatWeightSource(
  variant: Pick<DietPlanVariant, 'weightSourceMode' | 'calculationWeight' | 'weightSourceDate'>,
): string {
  if (variant.calculationWeight === null) {
    return variant.weightSourceMode === 'latest'
      ? '自动跟随最新体重（等待有效记录）'
      : '手动体重未填写';
  }
  const weight = formatNutrition(variant.calculationWeight, 2) + ' kg';
  return variant.weightSourceMode === 'latest'
    ? '自动跟随最新体重：' + (variant.weightSourceDate ?? '日期未知') + ' · ' + weight
    : '手动输入体重：' + weight;
}

/** 新建日型沿用首个日型或方案目标作为初值，保存后仍保持独立计算来源。 */
function VariantForm({
  plan,
  state,
  variants,
  bodyRecords,
  pending,
  onCancel,
  onSubmit,
}: VariantFormProps) {
  const source = state.mode === 'create' ? null : state.variant;
  const targetSource = source ?? variants[0] ?? plan;
  const latestWeightRecord = useMemo(
    () => getValidWeightRecords(bodyRecords)[0] ?? null,
    [bodyRecords],
  );
  const [name, setName] = useState(
    state.mode === 'copy' ? `${source?.name ?? ''} 副本` : (source?.name ?? ''),
  );
  const [calculationMode, setCalculationMode] = useState<DietPlanCalculationMode>(
    targetSource.calculationMode,
  );
  const [weightSourceMode, setWeightSourceMode] = useState<DietPlanWeightSourceMode>(
    targetSource.calculationMode === 'weight_based' ? targetSource.weightSourceMode : 'latest',
  );
  const [calculationWeight, setCalculationWeight] = useState<number | null>(
    targetSource.calculationWeight ?? latestWeightRecord?.weight ?? null,
  );
  const [proteinPerKg, setProteinPerKg] = useState(
    String(targetSource.proteinPerKg ?? DEFAULT_PROTEIN_PER_KG),
  );
  const [carbsPerKg, setCarbsPerKg] = useState(
    String(targetSource.carbsPerKg ?? DEFAULT_CARBS_PER_KG),
  );
  const [fatPerKg, setFatPerKg] = useState(String(targetSource.fatPerKg ?? DEFAULT_FAT_PER_KG));
  const [calories, setCalories] = useState(String(targetSource.calories));
  const [protein, setProtein] = useState(String(targetSource.protein));
  const [carbs, setCarbs] = useState(String(targetSource.carbs));
  const [fat, setFat] = useState(String(targetSource.fat));
  const [note, setNote] = useState(source?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const macroCalories = useMemo(() => {
    const values = [protein, carbs, fat].map(parseTarget);
    if (values.some((value) => !Number.isFinite(value))) return null;
    return values[0] * 4 + values[1] * 4 + values[2] * 9;
  }, [carbs, fat, protein]);

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError('日型名称不能为空');
      return;
    }
    const duplicate = variants.some(
      (variant) =>
        variant.id !== (state.mode === 'edit' ? state.variant.id : null) &&
        variant.name.localeCompare(normalizedName, 'zh-CN', { sensitivity: 'accent' }) === 0,
    );
    if (duplicate) {
      setError('同一饮食方案下不能有重名日型');
      return;
    }
    const targets = [calories, protein, carbs, fat].map(parseTarget);
    if (targets.some((value) => !Number.isFinite(value) || value < 0)) {
      setError('热量和三大营养素必须是大于或等于 0 的数字');
      return;
    }
    const parsedProteinPerKg = parseTarget(proteinPerKg);
    const parsedCarbsPerKg = parseTarget(carbsPerKg);
    const parsedFatPerKg = parseTarget(fatPerKg);
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

    setError(null);
    await onSubmit({
      name: normalizedName,
      targetCalories: targets[0],
      targetProtein: targets[1],
      targetCarbs: targets[2],
      targetFat: targets[3],
      calculationMode,
      weightSourceMode: calculationMode === 'weight_based' ? weightSourceMode : 'latest',
      calculationWeight: calculationMode === 'weight_based' ? effectiveCalculationWeight : null,
      weightSourceDate: calculationMode === 'weight_based' ? effectiveWeightSourceDate : null,
      proteinPerKg: calculationMode === 'weight_based' ? parsedProteinPerKg : null,
      carbsPerKg: calculationMode === 'weight_based' ? parsedCarbsPerKg : null,
      fatPerKg: calculationMode === 'weight_based' ? parsedFatPerKg : null,
      note: note.trim(),
    });
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      {error ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}
      <Field label="日型名称 *" hint="用于区分同一方案中的训练日、休息日等安排。">
        <TextInput
          autoFocus
          disabled={pending}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：训练日、高碳日、训练日 · 高碳"
          required
          value={name}
        />
      </Field>
      <div className="flex flex-wrap gap-2" aria-label="日型名称建议">
        {VARIANT_NAME_SUGGESTIONS.map((suggestion) => (
          <button
            className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"
            disabled={pending}
            key={suggestion}
            onClick={() => setName(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <fieldset>
        <legend className="text-sm font-semibold text-slate-900">
          {name.trim() || '当前日型'}的目标
        </legend>
        <div className="mt-3">
          <WeightBasedTargetControls
            bodyRecords={bodyRecords}
            calculationMode={calculationMode}
            calculationWeight={calculationWeight}
            carbsPerKg={carbsPerKg}
            disabled={pending}
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
            disabled={pending}
            label="热量"
            onValueKcalChange={setCalories}
            required
            valueKcal={calories}
          />
          <Field label="蛋白质 (g)">
            <TextInput
              disabled={pending}
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
              disabled={pending}
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
              disabled={pending}
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
        <p className="rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-600">
          三大营养素换算热量为 {formatNutrition(macroCalories, 1)}{' '}
          kcal；这里只提示差值，不会自动修改填写值。
        </p>
      ) : null}
      <Field label="备注">
        <textarea
          className="mt-1.5 min-h-24 w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 disabled:bg-slate-100"
          disabled={pending}
          maxLength={1000}
          onChange={(event) => setNote(event.target.value)}
          placeholder="例如：力量训练日，提高碳水目标"
          value={note}
        />
      </Field>
      <div className="flex justify-end gap-3 border-t border-slate-200 pt-5">
        <button
          className={secondaryButtonClass}
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          返回日型列表
        </button>
        <button className={primaryButtonClass} disabled={pending} type="submit">
          {pending ? '正在保存…' : state.mode === 'edit' ? '保存日型' : '创建日型'}
        </button>
      </div>
    </form>
  );
}

function VariantTargetGrid({ variant }: { variant: DietPlanVariant }) {
  return (
    <div className="mt-3">
      <div className="grid grid-cols-4 gap-2 text-xs">
        {[
          ['热量', variant.calories, 'kcal'],
          ['蛋白质', variant.protein, 'g'],
          ['碳水', variant.carbs, 'g'],
          ['脂肪', variant.fat, 'g'],
        ].map(([label, value, unit]) => (
          <div className="rounded-lg bg-slate-50 px-2.5 py-2" key={String(label)}>
            <p className="text-slate-500">{label}</p>
            <p className="mt-0.5 font-semibold text-slate-800">
              {formatNutrition(Number(value), 1)} {unit}
            </p>
          </div>
        ))}
      </div>
      {variant.calculationMode === 'weight_based' ? (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700">
          {formatWeightSource(variant)}；蛋白质 {formatNutrition(variant.proteinPerKg ?? 0, 2)}
          、碳水 {formatNutrition(variant.carbsPerKg ?? 0, 2)}、脂肪{' '}
          {formatNutrition(variant.fatPerKg ?? 0, 2)} g/kg
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-400">手动填写</p>
      )}
    </div>
  );
}

/** 在一个弹窗内管理同一饮食方案的全部日型计划。 */
export function DietPlanVariantsDialog({
  open,
  plan,
  variants,
  bodyRecords,
  onClose,
  onVariantsChange,
}: DietPlanVariantsDialogProps) {
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const beginSaving = useAppStore((state) => state.beginSaving);
  const finishSaving = useAppStore((state) => state.finishSaving);
  const reportSaveError = useAppStore((state) => state.reportSaveError);
  const [formState, setFormState] = useState<VariantFormState>({ mode: 'list' });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setFormState({ mode: 'list' });
    setError(null);
  }, [open, plan?.id]);

  async function runMutation(operation: () => Promise<DietPlanVariant[]>): Promise<void> {
    if (pendingRef.current || !plan) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    beginSaving();
    try {
      const nextVariants = await operation();
      onVariantsChange(plan.id, nextVariants);
      await loadDashboard();
      finishSaving();
      setFormState({ mode: 'list' });
    } catch (mutationError) {
      const message = getErrorMessage(mutationError);
      setError(message);
      reportSaveError(message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function saveVariant(input: DietPlanVariantUpdateInput): Promise<void> {
    if (!plan || formState.mode === 'list') return;
    await runMutation(async () => {
      if (formState.mode === 'edit') {
        const saved = unwrapApiResult(
          await getDietTrackerApi().updateDietPlanVariant(formState.variant.id, input),
        );
        return variants.map((variant) => (variant.id === saved.id ? saved : variant));
      }
      const saved = unwrapApiResult(
        await getDietTrackerApi().createDietPlanVariant({ planId: plan.id, ...input }),
      );
      return [...variants, saved].sort((left, right) => left.id - right.id);
    });
  }

  async function deleteVariant(variant: DietPlanVariant): Promise<void> {
    if (
      pendingRef.current ||
      !window.confirm(`确定删除日型“${variant.name}”吗？历史日期仍会保留当时的名称和目标。`)
    ) {
      return;
    }
    await runMutation(async () => {
      unwrapApiResult(await getDietTrackerApi().deleteDietPlanVariant(variant.id));
      return variants.filter((candidate) => candidate.id !== variant.id);
    });
  }

  const title =
    formState.mode === 'list'
      ? '管理日型计划'
      : formState.mode === 'edit'
        ? '编辑日型计划'
        : formState.mode === 'copy'
          ? '复制日型计划'
          : '新建日型计划';

  return (
    <Modal
      closeDisabled={pending}
      description={plan ? `所属方案：${plan.name}` : undefined}
      onClose={onClose}
      open={open && Boolean(plan)}
      title={title}
      widthClassName="max-w-4xl"
    >
      {plan && formState.mode !== 'list' ? (
        <div className="space-y-4">
          {error ? (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
          ) : null}
          <VariantForm
            bodyRecords={bodyRecords}
            key={`${formState.mode}:${formState.mode === 'create' ? 'new' : formState.variant.id}`}
            onCancel={() => setFormState({ mode: 'list' })}
            onSubmit={saveVariant}
            pending={pending}
            plan={plan}
            state={formState}
            variants={variants}
          />
        </div>
      ) : plan ? (
        <div className="space-y-4">
          {error ? (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
          ) : null}
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm leading-6 text-slate-600">
              这些日型都属于“{plan.name}
              ”。切换日期时只选择当天采用哪套目标；首个日型用于尚未单独选择的日期。
            </p>
            <button
              className={primaryButtonClass}
              disabled={pending}
              onClick={() => setFormState({ mode: 'create' })}
              type="button"
            >
              <Plus className="size-4" />
              新建日型
            </button>
          </div>
          {variants.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center text-sm text-slate-500">
              <Tag className="mx-auto mb-3 size-6 text-slate-400" />
              暂无日型计划。可创建“训练日”“休息日”“高碳日”“低碳日”或任意自定义名称。
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {variants.map((variant) => (
                <article className="rounded-xl border border-slate-200 p-4" key={variant.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold text-slate-900">{variant.name}</h3>
                      {variant.note ? (
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                          {variant.note}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        aria-label={`编辑 ${variant.name}`}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        disabled={pending}
                        onClick={() => setFormState({ mode: 'edit', variant })}
                        type="button"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        aria-label={`复制 ${variant.name}`}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        disabled={pending}
                        onClick={() => setFormState({ mode: 'copy', variant })}
                        type="button"
                      >
                        <Copy className="size-4" />
                      </button>
                      <button
                        aria-label={`删除 ${variant.name}`}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        disabled={pending}
                        onClick={() => void deleteVariant(variant)}
                        type="button"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                  <VariantTargetGrid variant={variant} />
                </article>
              ))}
            </div>
          )}
          <div className="flex justify-end border-t border-slate-200 pt-4">
            <button
              className={secondaryButtonClass}
              disabled={pending}
              onClick={onClose}
              type="button"
            >
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
