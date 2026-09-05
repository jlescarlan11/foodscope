import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('runtime configuration', () => {
  const validEnvironment = {
    DATABASE_URL: 'mysql://app:fake@localhost:3306/foodscope_test',
    OPEN_FOOD_FACTS_USER_AGENT: 'Foodscope/1.0 (ops@foodscope.test)',
  };

  it('requires an identifiable Open Food Facts User-Agent', () => {
    expect(() => loadConfig({})).toThrow('OPEN_FOOD_FACTS_USER_AGENT');
    expect(() => loadConfig({
      OPEN_FOOD_FACTS_USER_AGENT: 'FoodscopeTechnicalAssessment/1.0 (contact@example.com)',
    })).toThrow('OPEN_FOOD_FACTS_USER_AGENT');
    expect(() => loadConfig({
      OPEN_FOOD_FACTS_USER_AGENT: 'Foodscope',
    })).toThrow('OPEN_FOOD_FACTS_USER_AGENT');
    expect(() => loadConfig({
      DATABASE_URL: validEnvironment.DATABASE_URL,
      OPEN_FOOD_FACTS_USER_AGENT: 'Foodscope/1.0 (not-a-contact)',
    })).toThrow('OPEN_FOOD_FACTS_USER_AGENT');
  });

  it('accepts an application, version, and non-placeholder contact', () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      port: 4000,
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'Foodscope/1.0 (ops@foodscope.test)',
    });
  });

  it('requires a structurally valid MySQL database URL', () => {
    for (const databaseUrl of [undefined, '', 'postgres://localhost/foodscope', 'mysql://localhost']) {
      expect(() => loadConfig({
        ...validEnvironment,
        DATABASE_URL: databaseUrl,
      })).toThrow('DATABASE_URL must be a MySQL database URL');
    }
  });

  it('rejects ports that cannot be listened on', () => {
    for (const port of ['', 'abc', '0', '65536', '4000.5']) {
      expect(() => loadConfig({ ...validEnvironment, PORT: port })).toThrow(
        'PORT must be an integer from 1 to 65535',
      );
    }
  });

  it('requires one HTTP(S) frontend origin and normalizes a trailing slash', () => {
    for (const frontendUrl of [
      '*',
      'frontend.example',
      'ftp://frontend.example',
      'https://frontend.example/path',
      'https://user:secret@frontend.example',
    ]) {
      expect(() => loadConfig({ ...validEnvironment, FRONTEND_URL: frontendUrl })).toThrow(
        'FRONTEND_URL must be an absolute HTTP(S) origin',
      );
    }

    expect(loadConfig({
      ...validEnvironment,
      FRONTEND_URL: 'https://frontend.example/',
    }).frontendUrl).toBe('https://frontend.example');
  });

  it('requires HTTPS for non-loopback production frontend origins', () => {
    expect(() => loadConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      FRONTEND_URL: 'http://frontend.example',
    })).toThrow('FRONTEND_URL must use HTTPS in production');

    expect(loadConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      FRONTEND_URL: 'http://localhost:3000',
    }).frontendUrl).toBe('http://localhost:3000');
  });

  it('rejects incomplete or structurally invalid Stripe configuration at startup', () => {
    const validStripe = {
      STRIPE_SECRET_KEY: 'sk_test_fake',
      STRIPE_WEBHOOK_SECRET: 'whsec_fake',
      STRIPE_PRICE_ID: 'price_fake',
    };
    const invalidEnvironments = [
      { STRIPE_PRICE_ID: 'price_fake' },
      { ...validStripe, STRIPE_SECRET_KEY: 'sk_live_fake' },
      { ...validStripe, STRIPE_SECRET_KEY: 'sk_test_' },
      { ...validStripe, STRIPE_WEBHOOK_SECRET: 'secret_fake' },
      { ...validStripe, STRIPE_PRICE_ID: 'product_fake' },
    ];

    for (const stripeEnvironment of invalidEnvironments) {
      expect(() => loadConfig({ ...validEnvironment, ...stripeEnvironment })).toThrow();
    }
  });

  it('accepts complete Stripe test configuration and normalizes blank optional values', () => {
    expect(loadConfig({
      ...validEnvironment,
      STRIPE_SECRET_KEY: ' rk_test_fake ',
      STRIPE_WEBHOOK_SECRET: ' whsec_fake ',
      STRIPE_PRICE_ID: ' price_fake ',
    })).toMatchObject({
      stripeSecretKey: 'rk_test_fake',
      stripeWebhookSecret: 'whsec_fake',
      stripePriceId: 'price_fake',
    });
    expect(loadConfig({
      ...validEnvironment,
      STRIPE_SECRET_KEY: ' ',
      STRIPE_WEBHOOK_SECRET: '',
    })).toMatchObject({
      stripeSecretKey: undefined,
      stripeWebhookSecret: undefined,
      stripePriceId: undefined,
    });
  });
});
