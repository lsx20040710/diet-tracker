import { describe, expect, it } from 'vitest';

import {
  formatMealAmount,
  adjustMealAmountInput,
  getMealAmountInputMin,
  getMealAmountInputStep,
  isMealAmountValid,
  normalizeMealAmountInput,
  normalizeMealAmountValue,
} from '../src/utils/meal-amount';

describe('饮食数量规则', () => {
  it('按个记录每次增减一个，同时接受半个鸡蛋', () => {
    expect(getMealAmountInputMin()).toBe('0.1');
    expect(getMealAmountInputStep('serving')).toBe('1');
    expect(isMealAmountValid(3)).toBe(true);
    expect(isMealAmountValid(3.5)).toBe(true);
    expect(isMealAmountValid(0.5)).toBe(true);
    expect(normalizeMealAmountInput('3', 'serving')).toBe('3');
  });

  it('按克记录统一使用一位小数，并为整数补零', () => {
    expect(getMealAmountInputMin()).toBe('0.1');
    expect(getMealAmountInputStep('gram')).toBe('0.1');
    expect(normalizeMealAmountInput('3', 'gram')).toBe('3.0');
    expect(normalizeMealAmountValue(33.26, 'gram')).toBe(33.3);
    expect(formatMealAmount(3, 'gram')).toBe('3.0');
  });

  it('按份记录仍允许可分割的份数', () => {
    expect(getMealAmountInputStep('serving')).toBe('1');
    expect(isMealAmountValid(1.5)).toBe(true);
    expect(formatMealAmount(1.5, 'serving')).toBe('1.5');
  });

  it('按份快捷增减一份并保留小数', () => {
    expect(getMealAmountInputStep('serving')).toBe('1');
    expect(adjustMealAmountInput('1', 'serving', 1)).toBe('2');
    expect(adjustMealAmountInput('1.5', 'serving', 1)).toBe('2.5');
    expect(adjustMealAmountInput('1.5', 'serving', -1)).toBe('0.5');
    expect(normalizeMealAmountInput('0.25', 'serving')).toBe('0.25');
  });

  it('小数份量增减无浮点残留，且不会减成零或负数', () => {
    expect(adjustMealAmountInput('1.1', 'serving', -1)).toBe('0.1');
    expect(adjustMealAmountInput('0.1', 'serving', 1)).toBe('1.1');
    expect(adjustMealAmountInput('0.5', 'serving', -1)).toBe('0.5');
    expect(adjustMealAmountInput('1', 'serving', -1)).toBe('1');
    expect(adjustMealAmountInput('1.12345', 'serving', 1)).toBe('2.12345');
    expect(adjustMealAmountInput('', 'serving', 1)).toBe('1');
    expect(adjustMealAmountInput('', 'gram', 1)).toBe('0.1');
    expect(adjustMealAmountInput('3.1', 'gram', -1)).toBe('3.0');
    expect(adjustMealAmountInput('3.0', 'gram', 1)).toBe('3.1');
  });

  it.each([0, -1, 0.01, NaN, Infinity])('拒绝无效数量 %s', (value) => {
    expect(isMealAmountValid(value)).toBe(false);
    expect(isMealAmountValid(value)).toBe(false);
  });
});
