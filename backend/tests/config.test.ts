import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('runtime configuration', () => {
  const validEnvironment = {
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
  });

  it('accepts an application, version, and non-placeholder contact', () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      port: 4000,
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'Foodscope/1.0 (ops@foodscope.test)',
    });
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
});
