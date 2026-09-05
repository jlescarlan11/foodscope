import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('runtime configuration', () => {
  it('requires an identifiable Open Food Facts User-Agent', () => {
    expect(() => loadConfig({})).toThrow('OPEN_FOOD_FACTS_USER_AGENT');
    expect(() => loadConfig({
      OPEN_FOOD_FACTS_USER_AGENT: 'FoodscopeTechnicalAssessment/1.0 (contact@example.com)',
    })).toThrow('OPEN_FOOD_FACTS_USER_AGENT');
    expect(() => loadConfig({
      OPEN_FOOD_FACTS_USER_AGENT: 'Foodscope',
    })).toThrow('OPEN_FOOD_FACTS_USER_AGENT');
  });

  it('accepts an application, version, and non-placeholder contact', () => {
    expect(loadConfig({
      OPEN_FOOD_FACTS_USER_AGENT: 'Foodscope/1.0 (ops@foodscope.test)',
    })).toMatchObject({
      port: 4000,
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'Foodscope/1.0 (ops@foodscope.test)',
    });
  });
});
