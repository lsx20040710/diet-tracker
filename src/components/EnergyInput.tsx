import { useEffect, useId, useRef, useState } from 'react';

import { useSettingsStore } from '../stores/settings-store';
import { DEFAULT_APP_SETTINGS } from '../types/models';
import { convertEnergy, formatEnergyValue, type EnergyUnit } from '../utils/energy';

interface EnergyInputProps {
  valueKcal: string;
  onValueKcalChange: (valueKcal: string) => void;
  label: string;
  disabled?: boolean;
  required?: boolean;
  hint?: string;
}

function parseFiniteValue(value: string): number | null {
  if (value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getDisplayValue(valueKcal: string, unit: EnergyUnit): string {
  const parsed = parseFiniteValue(valueKcal);
  if (parsed === null) {
    return valueKcal;
  }
  return formatEnergyValue(convertEnergy(parsed, 'kcal', unit));
}

function getCanonicalKcal(value: number): string {
  // kJ 输入保留足够有效数字，避免切换单位时把显示舍入误差写回表单。
  return String(Number(value.toPrecision(15)));
}

/** 以 kcal 为对外数据契约，在组件内提供 kcal/kJ 切换和实时换算。 */
export function EnergyInput({
  valueKcal,
  onValueKcalChange,
  label,
  disabled = false,
  required = false,
  hint,
}: EnergyInputProps) {
  const inputId = useId();
  const defaultEnergyUnit = useSettingsStore(
    (state) => state.settings?.defaultEnergyUnit ?? DEFAULT_APP_SETTINGS.defaultEnergyUnit,
  );
  const [unit, setUnit] = useState<EnergyUnit>(defaultEnergyUnit);
  const [displayValue, setDisplayValue] = useState(() =>
    getDisplayValue(valueKcal, defaultEnergyUnit),
  );
  const canonicalKcalRef = useRef(valueKcal);
  const lastEmittedKcalRef = useRef<string | null>(null);

  useEffect(() => {
    setUnit(defaultEnergyUnit);
  }, [defaultEnergyUnit]);

  useEffect(() => {
    canonicalKcalRef.current = valueKcal;
    const isCurrentInputEcho = lastEmittedKcalRef.current === valueKcal;
    // 只跳过紧随本次输入的父级回显，外部更新必须清除旧标记并刷新显示值。
    lastEmittedKcalRef.current = null;
    if (isCurrentInputEcho) {
      return;
    }
    setDisplayValue(getDisplayValue(valueKcal, unit));
  }, [unit, valueKcal]);

  function handleValueChange(rawValue: string) {
    setDisplayValue(rawValue);
    if (rawValue.trim() === '') {
      canonicalKcalRef.current = '';
      lastEmittedKcalRef.current = '';
      onValueKcalChange('');
      return;
    }

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      // 保留浏览器允许的临时编辑状态，提交时仍由表单统一拦截。
      canonicalKcalRef.current = rawValue;
      lastEmittedKcalRef.current = rawValue;
      onValueKcalChange(rawValue);
      return;
    }

    const nextKcal =
      unit === 'kcal' ? rawValue : getCanonicalKcal(convertEnergy(parsed, 'kJ', 'kcal'));
    canonicalKcalRef.current = nextKcal;
    lastEmittedKcalRef.current = nextKcal;
    onValueKcalChange(nextKcal);
  }

  function handleUnitChange(nextUnit: EnergyUnit) {
    setUnit(nextUnit);
    setDisplayValue(getDisplayValue(canonicalKcalRef.current, nextUnit));
  }

  const parsedDisplayValue = parseFiniteValue(displayValue);
  const alternateUnit: EnergyUnit = unit === 'kcal' ? 'kJ' : 'kcal';
  const alternateValue =
    parsedDisplayValue === null
      ? null
      : formatEnergyValue(convertEnergy(parsedDisplayValue, unit, alternateUnit));

  return (
    <div className="text-sm font-medium text-slate-700">
      <label htmlFor={inputId}>{label}</label>
      <div className="mt-1.5 flex">
        <input
          aria-label={`${label}数值`}
          className="min-w-0 flex-1 rounded-l-lg border border-r-0 border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:z-10 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 disabled:bg-slate-100"
          disabled={disabled}
          id={inputId}
          min="0"
          onChange={(event) => handleValueChange(event.target.value)}
          required={required}
          step="0.0001"
          type="number"
          value={displayValue}
        />
        <select
          aria-label={`${label}单位`}
          className="rounded-r-lg border border-slate-300 bg-slate-50 px-2 py-2 text-sm text-slate-700 outline-none transition focus:z-10 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/15 disabled:bg-slate-100 shrink-0"
          disabled={disabled}
          onChange={(event) => handleUnitChange(event.target.value as EnergyUnit)}
          value={unit}
        >
          <option value="kcal">kcal</option>
          <option value="kJ">kJ</option>
        </select>
      </div>
      <span className="mt-1 block min-h-4 text-xs font-normal text-slate-500">
        {alternateValue === null
          ? `${hint ? `${hint} · ` : ''}1 kcal = 4.184 kJ`
          : `${hint ? `${hint} · ` : ''}换算：${alternateValue} ${alternateUnit} · 1 kcal = 4.184 kJ`}
      </span>
    </div>
  );
}
