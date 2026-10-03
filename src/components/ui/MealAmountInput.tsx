import { Minus, Plus } from 'lucide-react';
import { useId, type InputHTMLAttributes } from 'react';

import type { UnitType } from '../../types/models';
import {
  adjustMealAmountInput,
  getMealAmountInputMin,
  getMealAmountInputStep,
  normalizeMealAmountInput,
} from '../../utils/meal-amount';
import { TextInput } from './FormControls';

interface MealAmountInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'step' | 'min'
> {
  value: string;
  unitType: UnitType;
  unitName?: string | null;
  onValueChange: (value: string) => void;
}

/** 手动输入允许小数，按钮与上下方向键按固定份数增减。 */
export function MealAmountInput({
  value,
  unitType,
  unitName,
  onValueChange,
  className = '',
  disabled,
  readOnly,
  onBlur,
  onKeyDown,
  ...props
}: MealAmountInputProps) {
  const hintId = useId();
  const stepLabel = unitType === 'serving' ? `1 ${unitName?.trim() || '份'}` : '0.1 克';
  const locked = disabled || readOnly;
  const adjust = (direction: 1 | -1) => {
    if (!locked) onValueChange(adjustMealAmountInput(value, unitType, direction));
  };
  const buttonClass =
    'flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:border-emerald-400 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-emerald-600 disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <span className={`mt-1.5 block min-w-0 ${className}`}>
      <span className="flex items-center gap-1.5">
        <button
          aria-label={`减少 ${stepLabel}`}
          className={buttonClass}
          disabled={
            locked ||
            (value.trim() !== '' &&
              Number(value) - Number(getMealAmountInputStep(unitType)) < 0.1 - Number.EPSILON)
          }
          onClick={() => adjust(-1)}
          type="button"
        >
          <Minus className="size-4" />
        </button>
        <TextInput
          {...props}
          aria-describedby={[props['aria-describedby'], hintId].filter(Boolean).join(' ')}
          className="meal-amount-input mt-0 min-w-0 flex-1 px-2 text-center tabular-nums"
          disabled={disabled}
          min={getMealAmountInputMin()}
          onBlur={(event) => {
            const normalized = normalizeMealAmountInput(value, unitType);
            if (normalized !== value) onValueChange(normalized);
            onBlur?.(event);
          }}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented || locked) return;
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              adjust(event.key === 'ArrowUp' ? 1 : -1);
            }
          }}
          readOnly={readOnly}
          step="any"
          type="number"
          value={value}
        />
        <button
          aria-label={`增加 ${stepLabel}`}
          className={buttonClass}
          disabled={locked}
          onClick={() => adjust(1)}
          type="button"
        >
          <Plus className="size-4" />
        </button>
      </span>
      <span className="mt-1 block text-xs font-normal text-slate-500" id={hintId}>
        {unitType === 'serving' ? '可填小数；每次增减 1 份' : '每次增减 0.1 克'}
      </span>
    </span>
  );
}
