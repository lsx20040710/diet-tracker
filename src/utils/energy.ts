import type { EnergyUnit } from '../types/models';

export type { EnergyUnit } from '../types/models';

export const KILOJOULES_PER_KILOCALORIE = 4.184;

function assertFiniteEnergy(value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error('热量必须是有限数字');
  }
}

/** 将千卡转换为千焦，不在计算层截断小数。 */
export function kilocaloriesToKilojoules(kilocalories: number): number {
  assertFiniteEnergy(kilocalories);
  return kilocalories * KILOJOULES_PER_KILOCALORIE;
}

/** 将千焦转换为千卡，数据库和营养统计统一使用该单位。 */
export function kilojoulesToKilocalories(kilojoules: number): number {
  assertFiniteEnergy(kilojoules);
  return kilojoules / KILOJOULES_PER_KILOCALORIE;
}

/** 在界面支持的两种热量单位之间转换。 */
export function convertEnergy(value: number, from: EnergyUnit, to: EnergyUnit): number {
  assertFiniteEnergy(value);
  if (from === to) {
    return value;
  }
  return from === 'kcal' ? kilocaloriesToKilojoules(value) : kilojoulesToKilocalories(value);
}

/** 将换算结果整理为最多指定位小数的界面文本。 */
export function formatEnergyValue(value: number, maximumFractionDigits = 4): string {
  assertFiniteEnergy(value);
  if (!Number.isInteger(maximumFractionDigits) || maximumFractionDigits < 0) {
    throw new Error('小数位数必须是大于或等于 0 的整数');
  }

  const rounded = Number(value.toFixed(maximumFractionDigits));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}
