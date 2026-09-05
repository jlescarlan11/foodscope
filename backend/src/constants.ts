export const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_USER_EMAIL = 'demo@foodscope.local';
export const SUPPORTED_LOCALES = ['en', 'nl', 'de', 'fr'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const NUTRITION_RULES = {
  energyKcal: { unit: 'kcal', maximum: 1_000 },
  fat: { unit: 'g', maximum: 100 },
  saturatedFat: { unit: 'g', maximum: 100 },
  carbohydrates: { unit: 'g', maximum: 100 },
  sugars: { unit: 'g', maximum: 100 },
  protein: { unit: 'g', maximum: 100 },
  salt: { unit: 'g', maximum: 100 },
  sodium: { unit: 'g', maximum: 100 },
} as const;

export const isActiveSubscription = (status: string) =>
  status === 'active' || status === 'trialing';
