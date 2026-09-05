import { describe, expect, it } from 'vitest';
import { resolveTestDatabaseUrl } from './test-database.js';

describe('integration database safety', () => {
  it('keeps database integration disabled when no target is configured', () => {
    expect(resolveTestDatabaseUrl(undefined)).toBeUndefined();
  });

  it.each([
    'mysql://app:fake@db.example.test/foodscope_test',
    'mysql://app:fake@127.0.0.1/food_search',
    'postgres://app:fake@127.0.0.1/foodscope_test',
    'not-a-database-url',
  ])('rejects a non-disposable integration target: %s', (databaseUrl) => {
    expect(() => resolveTestDatabaseUrl(databaseUrl)).toThrow(
      'Refusing to run integration tests against a non-disposable database',
    );
  });

  it.each([
    'mysql://app:fake@127.0.0.1:3306/foodscope_test',
    'mysql://app:fake@localhost:3306/foodscope_ci',
    'mysql://app:fake@[::1]:3306/foodscope_ci_order_test',
  ])('accepts an explicitly disposable loopback target: %s', (databaseUrl) => {
    expect(resolveTestDatabaseUrl(databaseUrl)).toBe(databaseUrl);
  });
});
