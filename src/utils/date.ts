/** 使用本地日期字段，避免 UTC 转换导致记录落到前一天。 */
export function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function todayString(): string {
  return toLocalDateString(new Date());
}

/** 校验数据库使用的本地日期字符串，避免无效日期进入全局页面状态。 */
export function isValidDateString(dateString: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999) {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function shiftDate(dateString: string, days: number): string {
  if (!isValidDateString(dateString) || !Number.isInteger(days)) {
    throw new Error('日期格式无效');
  }
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return toLocalDateString(date);
}

export function formatChineseDate(dateString: string): string {
  if (!isValidDateString(dateString)) {
    return '日期无效';
  }
  const [year, month, day] = dateString.split('-').map(Number);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(year, month - 1, day));
}
