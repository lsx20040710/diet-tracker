import type { UnitType } from '../types/models';

/** 所有单位均允许小数份量，例如半个鸡蛋、半杯牛奶。 */
export function getMealAmountInputMin(): string {
  return '0.1';
}

/** 快捷增减按份为 1，按克为 0.1；与手动输入精度分开。 */
export function getMealAmountInputStep(unitType: UnitType): string {
  return unitType === 'serving' ? '1' : '0.1';
}

/** 保留份数的小数部分，避免原生 number 步进把 1.5 对齐到整数。 */
export function adjustMealAmountInput(
  value: string,
  unitType: UnitType,
  direction: 1 | -1,
): string {
  const parsedValue = Number(value);
  const current =
    value.trim() && Number.isFinite(parsedValue) && parsedValue >= 0.1 ? parsedValue : 0;
  const next = current + direction * Number(getMealAmountInputStep(unitType));
  // 有效数量不足一步时保持原值，避免减一份变成减 0.4 份。
  if (current >= 0.1 && next < 0.1 - Number.EPSILON) return value;
  // 用当前输入的精度消除浮点加减误差，不截断手动输入的小数份量。
  const precision = Math.min(15, Math.max(1, current.toString().split('.')[1]?.length ?? 0));
  const rounded = Math.max(0.1, Number(next.toFixed(precision)));
  return unitType === 'gram' ? rounded.toFixed(1) : String(rounded);
}

/** 将重量数量统一舍入到小数点后一位，份数和个数保留原始数值。 */
export function normalizeMealAmountValue(value: number, unitType: UnitType): number {
  if (unitType !== 'gram' || !Number.isFinite(value)) return value;
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/** 校验数量是否符合当前单位的最小值和精度要求。 */
export function isMealAmountValid(value: number): boolean {
  return Number.isFinite(value) && value >= 0.1;
}

/** 输入框失焦时整理数量，重量显示一位小数，整数个数保持整数显示。 */
export function normalizeMealAmountInput(value: string, unitType: UnitType): string {
  if (!value.trim()) return value;
  const parsedValue = Number(value);
  const normalizedValue = normalizeMealAmountValue(parsedValue, unitType);
  if (!isMealAmountValid(normalizedValue)) return value;
  return unitType === 'gram' ? normalizedValue.toFixed(1) : String(normalizedValue);
}

/** 统一记录列表、历史和常用组合中的数量显示格式。 */
export function formatMealAmount(value: number, unitType: UnitType): string {
  if (unitType === 'gram') {
    return normalizeMealAmountValue(value, unitType).toLocaleString('zh-CN', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}
