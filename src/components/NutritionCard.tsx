import { calculateProgressPercent, formatNutrition } from '../utils/nutrition';

interface NutritionCardProps {
  label: string;
  consumed: number;
  target: number;
  unit: string;
  colorClassName: string;
  digits?: number;
}

export function NutritionCard({
  label,
  consumed,
  target,
  unit,
  colorClassName,
  digits = 1,
}: NutritionCardProps) {
  const remaining = target - consumed;
  const percent = calculateProgressPercent(consumed, target);
  const displayPercent = target <= 0 ? (consumed > 0 ? '—' : '0%') : `${percent.toFixed(1)}%`;
  const progressWidth = Math.min(percent, 100);
  const closeToTarget = target > 0 && percent >= 85 && percent <= 100;
  const exceeded = target > 0 && remaining < 0;

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-600">{label}</h3>
        <span
          className={`text-xs font-semibold ${
            exceeded ? 'text-red-600' : closeToTarget ? 'text-amber-600' : 'text-slate-500'
          }`}
        >
          {displayPercent}
        </span>
      </div>
      <p className="mt-2 text-lg font-semibold tracking-tight text-slate-950">
        {formatNutrition(consumed, digits)}
        <span className="mx-1 text-sm font-normal text-slate-400">/</span>
        <span className="text-sm font-medium text-slate-600">
          {formatNutrition(target, digits)} {unit}
        </span>
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            exceeded ? 'bg-red-500' : closeToTarget ? 'bg-amber-500' : colorClassName
          }`}
          style={{ width: `${progressWidth}%` }}
        />
      </div>
      <p className={`mt-2 text-xs ${exceeded ? 'font-medium text-red-600' : 'text-slate-500'}`}>
        {target <= 0
          ? consumed > 0
            ? `目标未设置，已摄入 ${formatNutrition(consumed, digits)} ${unit}`
            : '目标未设置'
          : exceeded
            ? `超出 ${formatNutrition(Math.abs(remaining), digits)} ${unit}`
            : closeToTarget
              ? `即将完成，剩余 ${formatNutrition(remaining, digits)} ${unit}`
              : `剩余 ${formatNutrition(remaining, digits)} ${unit}`}
      </p>
    </article>
  );
}
