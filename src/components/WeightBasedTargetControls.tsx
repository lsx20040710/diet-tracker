import { useEffect, useMemo } from 'react';

import type {
  BodyRecord,
  DietPlanCalculationMode,
  DietPlanWeightSourceMode,
  NutritionTarget,
} from '../types/models';
import { calculateWeightBasedPlan, getValidWeightRecords } from '../utils/diet-plan';
import { formatNutrition } from '../utils/nutrition';
import { Field, secondaryButtonClass, TextInput } from './ui/FormControls';

interface WeightBasedTargetControlsProps {
  bodyRecords: BodyRecord[];
  calculationMode: DietPlanCalculationMode;
  weightSourceMode: DietPlanWeightSourceMode;
  calculationWeight: number | null;
  proteinPerKg: string;
  carbsPerKg: string;
  fatPerKg: string;
  disabled?: boolean;
  onCalculationModeChange: (mode: DietPlanCalculationMode) => void;
  onWeightSourceModeChange: (mode: DietPlanWeightSourceMode) => void;
  onCalculationWeightChange: (weight: number | null) => void;
  onProteinPerKgChange: (value: string) => void;
  onCarbsPerKgChange: (value: string) => void;
  onFatPerKgChange: (value: string) => void;
  onApplyTarget: (target: NutritionTarget) => void;
}

function parseCoefficient(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function getPreview(
  weight: number | null,
  proteinPerKg: string,
  carbsPerKg: string,
  fatPerKg: string,
): NutritionTarget | null {
  if (weight === null) return null;
  try {
    return calculateWeightBasedPlan({
      weight,
      proteinPerKg: parseCoefficient(proteinPerKg),
      carbsPerKg: parseCoefficient(carbsPerKg),
      fatPerKg: parseCoefficient(fatPerKg),
    });
  } catch {
    return null;
  }
}

/** 为当前方案或日型编辑体重来源、营养系数和计算预览。 */
export function WeightBasedTargetControls({
  bodyRecords,
  calculationMode,
  weightSourceMode,
  calculationWeight,
  proteinPerKg,
  carbsPerKg,
  fatPerKg,
  disabled = false,
  onCalculationModeChange,
  onWeightSourceModeChange,
  onCalculationWeightChange,
  onProteinPerKgChange,
  onCarbsPerKgChange,
  onFatPerKgChange,
  onApplyTarget,
}: WeightBasedTargetControlsProps) {
  const latestWeightRecord = useMemo(
    () => getValidWeightRecords(bodyRecords)[0] ?? null,
    [bodyRecords],
  );
  const effectiveWeight =
    weightSourceMode === 'latest' ? (latestWeightRecord?.weight ?? null) : calculationWeight;
  const preview = useMemo(
    () => getPreview(effectiveWeight, proteinPerKg, carbsPerKg, fatPerKg),
    [carbsPerKg, effectiveWeight, fatPerKg, proteinPerKg],
  );

  useEffect(() => {
    if (calculationMode !== 'weight_based' || weightSourceMode !== 'latest' || !preview) return;
    // 自动来源变更时立即同步表单目标，保存前后的数值保持一致。
    onApplyTarget(preview);
  }, [calculationMode, onApplyTarget, preview, weightSourceMode]);

  function applyPreview(
    weight: number | null,
    nextProteinPerKg = proteinPerKg,
    nextCarbsPerKg = carbsPerKg,
    nextFatPerKg = fatPerKg,
  ) {
    const nextPreview = getPreview(weight, nextProteinPerKg, nextCarbsPerKg, nextFatPerKg);
    if (nextPreview) onApplyTarget(nextPreview);
  }

  return (
    <>
      <div className="inline-flex rounded-lg bg-slate-100 p-1 text-sm">
        <button
          className={
            'rounded-md px-3 py-1.5 ' +
            (calculationMode === 'manual'
              ? 'bg-white font-medium text-slate-900 shadow-sm'
              : 'text-slate-500')
          }
          disabled={disabled}
          onClick={() => onCalculationModeChange('manual')}
          type="button"
        >
          手动填写
        </button>
        <button
          className={
            'rounded-md px-3 py-1.5 ' +
            (calculationMode === 'weight_based'
              ? 'bg-white font-medium text-emerald-700 shadow-sm'
              : 'text-slate-500')
          }
          disabled={disabled}
          onClick={() => onCalculationModeChange('weight_based')}
          type="button"
        >
          按体重系数生成
        </button>
      </div>

      {calculationMode === 'weight_based' ? (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-sm font-medium text-emerald-900">
              <input
                checked={weightSourceMode === 'latest'}
                disabled={disabled}
                onChange={(event) => {
                  if (event.target.checked) {
                    onWeightSourceModeChange('latest');
                    applyPreview(latestWeightRecord?.weight ?? null);
                    return;
                  }
                  const manualWeight = latestWeightRecord?.weight ?? calculationWeight;
                  onCalculationWeightChange(manualWeight);
                  onWeightSourceModeChange('manual');
                  applyPreview(manualWeight);
                }}
                type="checkbox"
              />
              自动跟随最新体重
            </label>
            {weightSourceMode === 'latest' && latestWeightRecord ? (
              <span className="text-xs text-emerald-700">
                当前：{latestWeightRecord.recordDate} ·{' '}
                {formatNutrition(latestWeightRecord.weight, 2)} kg
              </span>
            ) : null}
          </div>
          {weightSourceMode === 'latest' && latestWeightRecord === null ? (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              暂无包含有效体重的身体记录；可直接输入体重后继续计算。
            </p>
          ) : null}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.5fr_repeat(3,1fr)]">
            <Field
              hint={
                weightSourceMode === 'latest'
                  ? '直接修改会关闭自动更新。'
                  : '已固定为手动输入，不再随体重记录变化。'
              }
              label="计算体重 (kg)"
            >
              <TextInput
                disabled={disabled}
                max="1000"
                min="0.01"
                onChange={(event) => {
                  const value = event.target.value;
                  const weight = value === '' ? null : Number(value);
                  const manualWeight = Number.isFinite(weight) ? weight : null;
                  onWeightSourceModeChange('manual');
                  onCalculationWeightChange(manualWeight);
                  applyPreview(manualWeight);
                }}
                step="any"
                type="number"
                value={effectiveWeight === null ? '' : String(effectiveWeight)}
              />
            </Field>
            <Field label="蛋白质系数 (g/kg)">
              <TextInput
                disabled={disabled}
                max="20"
                min="0"
                onChange={(event) => {
                  const value = event.target.value;
                  onProteinPerKgChange(value);
                  applyPreview(effectiveWeight, value);
                }}
                required
                step="any"
                type="number"
                value={proteinPerKg}
              />
            </Field>
            <Field label="碳水系数 (g/kg)">
              <TextInput
                disabled={disabled}
                max="20"
                min="0"
                onChange={(event) => {
                  const value = event.target.value;
                  onCarbsPerKgChange(value);
                  applyPreview(effectiveWeight, proteinPerKg, value);
                }}
                required
                step="any"
                type="number"
                value={carbsPerKg}
              />
            </Field>
            <Field label="脂肪系数 (g/kg)">
              <TextInput
                disabled={disabled}
                max="20"
                min="0"
                onChange={(event) => {
                  const value = event.target.value;
                  onFatPerKgChange(value);
                  applyPreview(effectiveWeight, proteinPerKg, carbsPerKg, value);
                }}
                required
                step="any"
                type="number"
                value={fatPerKg}
              />
            </Field>
          </div>
          {preview ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-3 py-2.5 text-sm text-slate-700">
              <p>
                预览：蛋白质 {formatNutrition(preview.protein, 1)} g · 碳水{' '}
                {formatNutrition(preview.carbs, 1)} g · 脂肪 {formatNutrition(preview.fat, 1)} g ·
                热量 {formatNutrition(preview.calories, 1)} kcal
              </p>
              <button
                className={secondaryButtonClass}
                disabled={disabled}
                onClick={() => onApplyTarget(preview)}
                type="button"
              >
                应用计算结果
              </button>
            </div>
          ) : (
            <p className="mt-3 text-sm text-amber-700">
              请填写大于 0 的体重，并将三个系数填写为 0 到 20 之间的数字。
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}
