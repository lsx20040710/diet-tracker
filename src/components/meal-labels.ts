import { REGULAR_MEAL_TYPES, type MealType, type RegularMealType } from '../types/models';

export { REGULAR_MEAL_TYPES };
export type { RegularMealType };

export const mealLabels: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
  supplement: '补剂',
};
