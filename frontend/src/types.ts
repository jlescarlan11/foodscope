export type NutritionValue = { value: number; unit: 'g' | 'kcal' };
export type Nutrition = Partial<Record<'energyKcal' | 'fat' | 'saturatedFat' | 'carbohydrates' | 'sugars' | 'protein' | 'salt' | 'sodium', NutritionValue>>;
export type Product = { id: string; name: string | null; brand: string | null; image: string | null; nutrition?: Nutrition; nutritionLocked: boolean };
export type UserState = {
  nutritionAccess: boolean;
  billingAvailable: boolean;
  checkoutAvailable: boolean;
  subscriptionManagementAvailable: boolean;
  cancellationScheduled: boolean;
  currentPeriodEnd: string | null;
};
export type RecentSearch = { query: string; locale: string };
