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
const identifiableUserAgent = /^\S+\/\S+\s+\([^()\s@]+@[^()\s@]+\.[^()\s@]+\)$/;

function parsePort(value: string | undefined) {
  const port = Number(value ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  return port;
}

function parseFrontendOrigin(value: string | undefined, environment: string | undefined) {
  const input = value ?? 'http://localhost:3000';
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('FRONTEND_URL must be an absolute HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('FRONTEND_URL must be an absolute HTTP(S) origin');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (environment === 'production' && url.protocol !== 'https:' && !loopback) {
    throw new Error('FRONTEND_URL must use HTTPS in production');
  }
  return url.origin;
}

function validateDatabaseUrl(value: string | undefined) {
  if (!value) throw new Error('DATABASE_URL must be a MySQL database URL');
  try {
    const url = new URL(value);
    if (url.protocol !== 'mysql:' || !url.hostname || !url.pathname || url.pathname === '/') {
      throw new Error();
    }
  } catch {
    throw new Error('DATABASE_URL must be a MySQL database URL');
  }
}

function stripeConfig(environment: NodeJS.ProcessEnv) {
  const stripeSecretKey = environment.STRIPE_SECRET_KEY?.trim() || undefined;
  const stripeWebhookSecret = environment.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
  const stripePriceId = environment.STRIPE_PRICE_ID?.trim() || undefined;
  const values = [stripeSecretKey, stripeWebhookSecret, stripePriceId];
  if (values.every((value) => value === undefined)) {
    return { stripeSecretKey, stripeWebhookSecret, stripePriceId };
  }
  if (!stripeSecretKey || !stripeWebhookSecret || !stripePriceId) {
    throw new Error('Stripe configuration requires a test key, webhook secret, and Price ID');
  }
  if (!/^(?:sk|rk)_test_.+/.test(stripeSecretKey)) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe test-mode secret or restricted key');
  }
  if (!/^whsec_.+/.test(stripeWebhookSecret)) {
    throw new Error('STRIPE_WEBHOOK_SECRET must be a Stripe endpoint signing secret');
  }
  if (!/^price_.+/.test(stripePriceId)) {
    throw new Error('STRIPE_PRICE_ID must be a Stripe Price ID');
  }
  return { stripeSecretKey, stripeWebhookSecret, stripePriceId };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const openFoodFactsUserAgent = environment.OPEN_FOOD_FACTS_USER_AGENT?.trim();
  if (
    !openFoodFactsUserAgent ||
    placeholderUserAgent.test(openFoodFactsUserAgent) ||
    !identifiableUserAgent.test(openFoodFactsUserAgent)
  ) {
    throw new Error(
      'OPEN_FOOD_FACTS_USER_AGENT must identify the application, version, and a real contact',
    );
  }
  validateDatabaseUrl(environment.DATABASE_URL);
  const stripe = stripeConfig(environment);

  return {
    port: parsePort(environment.PORT),
    frontendUrl: parseFrontendOrigin(environment.FRONTEND_URL, environment.NODE_ENV),
    openFoodFactsUserAgent,
    ...stripe,
  };
}
