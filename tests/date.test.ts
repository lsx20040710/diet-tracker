import { describe, expect, it } from 'vitest';

import {
  formatChineseDate,
  isValidDateString,
  shiftDate,
  toLocalDateString,
} from '../src/utils/date';

describe('本地日期处理', () => {
  it('使用本地年月日生成数据库日期字符串', () => {
    expect(toLocalDateString(new Date(2026, 7, 10, 23, 59, 59))).toBe('2026-08-10');
  });

  it('前后切换日期时正确跨月', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftDate('2024-02-29', 1)).toBe('2024-03-01');
  });

  it('前后切换日期时正确跨年', () => {
    expect(shiftDate('2025-12-31', 1)).toBe('2026-01-01');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('格式化日期时包含完整日期和星期', () => {
    const formatted = formatChineseDate('2026-08-10');

    expect(formatted).toContain('2026年8月10日');
    expect(formatted).toMatch(/周一|星期一/);
  });

  it('拒绝空值和不存在的日期，格式化时不抛出异常', () => {
    expect(isValidDateString('')).toBe(false);
    expect(isValidDateString('2026-02-29')).toBe(false);
    expect(isValidDateString('2024-02-29')).toBe(true);
    expect(formatChineseDate('')).toBe('日期无效');
    expect(() => shiftDate('', 1)).toThrow('日期格式无效');
  });
});
