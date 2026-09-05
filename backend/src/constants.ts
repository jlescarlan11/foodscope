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

export const hasNutritionAccess = (status: string, currentPeriodEnd: Date | null, now = new Date()) =>
  isActiveSubscription(status) &&
  currentPeriodEnd instanceof Date &&
  Number.isFinite(currentPeriodEnd.getTime()) &&
  currentPeriodEnd > now;

export const CHECKOUT_ELIGIBLE_STATUSES = ['inactive', 'canceled', 'incomplete_expired'] as const;

export const canStartCheckout = (status: string) =>
  CHECKOUT_ELIGIBLE_STATUSES.some((eligibleStatus) => eligibleStatus === status);
