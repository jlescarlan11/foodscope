export const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_USER_EMAIL = 'demo@foodscope.local';
export const SUPPORTED_LOCALES = ['en', 'nl', 'de', 'fr'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const isActiveSubscription = (status: string) =>
  status === 'active' || status === 'trialing';
