import 'dotenv/config';

export type AppConfig = {
  port: number;
  frontendUrl: string;
  openFoodFactsUserAgent: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePriceId?: string;
};

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 4000),
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  openFoodFactsUserAgent:
    process.env.OPEN_FOOD_FACTS_USER_AGENT ?? 'FoodscopeTechnicalAssessment/1.0 (contact@example.com)',
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  stripePriceId: process.env.STRIPE_PRICE_ID,
};
