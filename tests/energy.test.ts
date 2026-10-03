import { describe, expect, it } from 'vitest';

import {
  convertEnergy,
  formatEnergyValue,
  kilocaloriesToKilojoules,
  kilojoulesToKilocalories,
  KILOJOULES_PER_KILOCALORIE,
} from '../src/utils/energy';

describe('热量单位换算', () => {
  it('按 1 kcal = 4.184 kJ 双向换算', () => {
    expect(KILOJOULES_PER_KILOCALORIE).toBe(4.184);
    expect(kilocaloriesToKilojoules(100)).toBeCloseTo(418.4, 12);
    expect(kilojoulesToKilocalories(418.4)).toBeCloseTo(100, 12);
    expect(convertEnergy(12.5, 'kcal', 'kJ')).toBeCloseTo(52.3, 12);
    expect(convertEnergy(52.3, 'kJ', 'kcal')).toBeCloseTo(12.5, 12);
  });

  it('稳定处理零值和相同单位', () => {
    expect(convertEnergy(0, 'kcal', 'kJ')).toBe(0);
    expect(convertEnergy(0, 'kJ', 'kcal')).toBe(0);
    expect(convertEnergy(123.4567, 'kcal', 'kcal')).toBe(123.4567);
  });

  it('显示保留最多四位小数，往返换算不累加显示舍入误差', () => {
    const sourceKcal = 123.4567;
    expect(formatEnergyValue(kilocaloriesToKilojoules(sourceKcal))).toBe('516.5428');

    let currentKcal = sourceKcal;
    for (let index = 0; index < 100; index += 1) {
      currentKcal = kilojoulesToKilocalories(kilocaloriesToKilojoules(currentKcal));
    }
    expect(currentKcal).toBeCloseTo(sourceKcal, 12);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    '拒绝非有限数值 %s',
    (value) => {
      expect(() => kilocaloriesToKilojoules(value)).toThrow('热量必须是有限数字');
      expect(() => kilojoulesToKilocalories(value)).toThrow('热量必须是有限数字');
      expect(() => formatEnergyValue(value)).toThrow('热量必须是有限数字');
    },
  );

  it('拒绝非法显示精度', () => {
    expect(() => formatEnergyValue(100, -1)).toThrow('小数位数必须是大于或等于 0 的整数');
    expect(() => formatEnergyValue(100, 1.5)).toThrow('小数位数必须是大于或等于 0 的整数');
  });
});
