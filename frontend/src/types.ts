export type Nutrition = Partial<Record<'energyKcal' | 'fat' | 'saturatedFat' | 'carbohydrates' | 'sugars' | 'protein' | 'salt' | 'sodium', number>>;
export type Product = { id: string; name: string | null; brand: string | null; image: string | null; nutrition?: Nutrition; nutritionLocked: boolean };
export type UserState = { email: string; subscriptionStatus: string; subscriptionCurrentPeriodEnd: string | null; nutritionAccess: boolean };
export type RecentSearch = { id: number; query: string; locale: string; createdAt: string };
