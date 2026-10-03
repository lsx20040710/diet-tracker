import { SUPPLEMENT_WEEKDAYS, type Food, type SupplementWeekday } from '../types/models';
import { formatMealAmount } from './meal-amount';

export { SUPPLEMENT_WEEKDAYS };
export type { SupplementWeekday };

export const supplementWeekdayLabels: Record<SupplementWeekday, string> = {
  monday: '周一',
  tuesday: '周二',
  wednesday: '周三',
  thursday: '周四',
  friday: '周五',
  saturday: '周六',
  sunday: '周日',
};

type SupplementPlan = Pick<
  Food,
  | 'supplementFrequency'
  | 'supplementWeekdays'
  | 'supplementDosage'
  | 'supplementDosageUnit'
  | 'unitName'
>;

/** 将结构化服用频率转换为补剂库和每日记录共用的短文案。 */
export function formatSupplementFrequency(supplement: SupplementPlan): string {
  if (supplement.supplementFrequency === 'daily') return '每天';
  if (supplement.supplementFrequency === 'as_needed') return '按需';
  if (supplement.supplementWeekdays.length === 0) return '未指定日期';
  return SUPPLEMENT_WEEKDAYS.filter((weekday) => supplement.supplementWeekdays.includes(weekday))
    .map((weekday) => supplementWeekdayLabels[weekday])
    .join('、');
}

/** 显示计划中的单次用量；按份记录沿用补剂自己的份量单位名称。 */
export function formatSupplementDosage(supplement: SupplementPlan): string {
  if (supplement.supplementDosage === null) return '未设置';
  const amount = formatMealAmount(supplement.supplementDosage, supplement.supplementDosageUnit);
  return supplement.supplementDosageUnit === 'gram'
    ? `${amount} g`
    : `${amount} ${supplement.unitName || '份'}`;
}
