import 'dotenv/config';

export type AppConfig = {
  port: number;
  frontendUrl: string;
  openFoodFactsUserAgent: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePriceId?: string;
};

const placeholderUserAgent = /(?:contact@example\.com|replace[_ -]?me|change[_ -]?me)/i;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const openFoodFactsUserAgent = environment.OPEN_FOOD_FACTS_USER_AGENT?.trim();
  if (
    !openFoodFactsUserAgent ||
    placeholderUserAgent.test(openFoodFactsUserAgent) ||
    !/^\S+\/\S+\s+\(.+\)$/.test(openFoodFactsUserAgent)
  ) {
    throw new Error(
      'OPEN_FOOD_FACTS_USER_AGENT must identify the application, version, and a real contact',
    );
  }

  return {
    port: Number(environment.PORT ?? 4000),
    frontendUrl: environment.FRONTEND_URL ?? 'http://localhost:3000',
    openFoodFactsUserAgent,
    stripeSecretKey: environment.STRIPE_SECRET_KEY,
    stripeWebhookSecret: environment.STRIPE_WEBHOOK_SECRET,
    stripePriceId: environment.STRIPE_PRICE_ID,
  };
}
