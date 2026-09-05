import type Stripe from 'stripe';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDependencies } from '../src/app.js';
import { DEMO_USER_ID, type Locale } from '../src/constants.js';
import { ProductProviderRateLimitError } from '../src/open-food-facts.js';
import { NutritionAccessAlreadyActiveError } from '../src/errors.js';
import type { DemoUser, RecentSearch, Repository } from '../src/types.js';

const baseUser: DemoUser = {
  id: DEMO_USER_ID, email: 'demo@foodscope.local', stripeCustomerId: null,
  stripeSubscriptionId: null, stripeCheckoutAttemptId: null, stripeCheckoutSessionId: null,
  stripeCheckoutSessionUrl: null, stripeCheckoutExpiresAt: null,
  subscriptionStatus: 'inactive', subscriptionCurrentPeriodEnd: null,
};

function harness(status = 'inactive') {
  let user = { ...baseUser, subscriptionStatus: status };
  const searches: RecentSearch[] = [];
  const repository: Repository = {
    getDemoUser: vi.fn(async () => user),
    saveSearch: vi.fn(async (_userId: string, query: string, locale: Locale) => {
      searches.unshift({ id: searches.length + 1, query, locale, createdAt: new Date() });
    }),
    getRecentSearches: vi.fn(async (_userId: string, limit: number) => searches.slice(0, limit)),
    setStripeCustomer: vi.fn(async (_userId: string, customerId: string) => { user = { ...user, stripeCustomerId: customerId }; }),
    getOrCreateCheckoutAttempt: vi.fn(async () => ({ id: 'attempt_test', expiresAt: new Date(), sessionUrl: null })),
    completeCheckoutAttempt: vi.fn(async () => undefined),
    isStripeEventProcessed: vi.fn(async () => false),
    processStripeEvent: vi.fn(async (
      event: Stripe.Event,
      retrieveSubscription?: (subscriptionId: string) => Promise<Stripe.Subscription>,
    ) => {
      if (event.type === 'customer.subscription.updated') {
        const currentSubscription = await retrieveSubscription!((event.data.object as Stripe.Subscription).id);
        user = { ...user, subscriptionStatus: currentSubscription!.status };
      }
    }),
  };
  const product = {
    id: '3017620422003', name: 'Hazelnut spread', brand: null, image: null,
    nutrition: { fat: { value: 30.9, unit: 'g' as const }, sugars: { value: 56.3, unit: 'g' as const } },
  };
  const event = { id: 'evt_test', type: 'customer.subscription.updated', data: { object: { id: 'sub_test', status: 'canceled' } } } as unknown as Stripe.Event;
  const currentSubscription = { id: 'sub_test', status: 'active' } as Stripe.Subscription;
  const dependencies: AppDependencies = {
    config: { port: 4000, frontendUrl: 'http://localhost:3000', openFoodFactsUserAgent: 'test' },
    repository,
    products: { search: vi.fn(async () => [product]) },
    billing: {
      createCheckout: vi.fn(async () => ({ url: 'https://checkout.stripe.test/session' })),
      constructEvent: vi.fn(() => event),
      retrieveSubscription: vi.fn(async () => currentSubscription),
    },
  };
  return { app: createApp(dependencies), repository, dependencies, event, currentSubscription };
}

function search(app: ReturnType<typeof createApp>, q: string, lang: string) {
  return request(app)
    .post('/api/products/search')
    .set('origin', 'http://localhost:3000')
    .send({ q, lang });
}

describe('Foodscope API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects blank searches and unsupported locales', async () => {
    const { app } = harness();
    expect((await search(app, ' ', 'en')).status).toBe(400);
    expect((await search(app, 'milk', 'es')).status).toBe(400);
  });

  it('rejects passive and cross-site search requests before provider work', async () => {
    const setup = harness();

    const legacyGet = await request(setup.app).get('/api/products/search?q=milk&lang=en');
    const untrustedOrigin = await request(setup.app)
      .post('/api/products/search')
      .set('origin', 'https://attacker.example')
      .send({ q: 'milk', lang: 'en' });

    expect(legacyGet.status).toBe(404);
    expect(untrustedOrigin.status).toBe(403);
    expect(setup.dependencies.products.search).not.toHaveBeenCalled();
    expect(setup.repository.saveSearch).not.toHaveBeenCalled();
  });

  it('classifies malformed and oversized JSON as non-retryable client errors', async () => {
    const setup = harness();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const malformed = await request(setup.app)
      .post('/api/billing/checkout-session')
      .set('content-type', 'application/json')
      .send('{');
    const oversized = await request(setup.app)
      .post('/api/billing/checkout-session')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(101 * 1024) }));

    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'Invalid JSON request' });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ error: 'Request body is too large' });
    expect(setup.dependencies.billing!.createCheckout).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('rejects cross-site Checkout creation before database or Stripe work', async () => {
    const setup = harness();

    const missingOrigin = await request(setup.app).post('/api/billing/checkout-session');
    const untrustedOrigin = await request(setup.app)
      .post('/api/billing/checkout-session')
      .set('origin', 'https://attacker.example');

    expect(missingOrigin.status).toBe(403);
    expect(untrustedOrigin.status).toBe(403);
    expect(setup.repository.getDemoUser).not.toHaveBeenCalled();
    expect(setup.dependencies.billing!.createCheckout).not.toHaveBeenCalled();
  });

  it('allows Checkout creation from the configured frontend origin', async () => {
    const setup = harness();

    const response = await request(setup.app)
      .post('/api/billing/checkout-session')
      .set('origin', setup.dependencies.config.frontendUrl);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(setup.dependencies.billing!.createCheckout).toHaveBeenCalledOnce();
  });

  it('returns a conflict when entitlement activates during Checkout creation', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.billing!.createCheckout)
      .mockRejectedValueOnce(new NutritionAccessAlreadyActiveError());

    const response = await request(setup.app)
      .post('/api/billing/checkout-session')
      .set('origin', setup.dependencies.config.frontendUrl);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'The demo user already has nutrition access' });
  });

  it('never sends nutrition to an inactive user', async () => {
    const response = await search(harness().app, 'spread', 'en');
    expect(response.status).toBe(200);
    expect(response.body.products[0]).toMatchObject({ nutritionLocked: true });
    expect(response.body.products[0]).not.toHaveProperty('nutrition');
  });

  it('reports missing nutrition as unavailable instead of claiming it is locked', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.products.search).mockResolvedValueOnce([{
      id: 'missing', name: 'No nutrition supplied', brand: null, image: null,
    }]);

    const response = await search(setup.app, 'missing', 'en');

    expect(response.status).toBe(200);
    expect(response.body.products[0]).toEqual({
      id: 'missing',
      name: 'No nutrition supplied',
      brand: null,
      image: null,
      nutritionLocked: false,
    });
    expect(response.body.products[0]).not.toHaveProperty('nutrition');
    expect(setup.repository.getDemoUser).toHaveBeenCalledOnce();
  });

  it('sends only available normalized nutrition to an active user', async () => {
    const setup = harness('active');
    vi.mocked(setup.dependencies.products.search).mockResolvedValueOnce([{
      id: '3017620422003', name: 'Hazelnut spread', brand: null, image: null,
      nutrition: {
        fat: { value: 30.9, unit: 'g', providerNote: 'must not cross' },
        energyKcal: { value: 44, unit: 'g' },
        privateNutrient: { value: 99, unit: 'g' },
      },
      providerInternalField: 'must not cross the API boundary',
    } as never]);

    const response = await search(setup.app, 'spread', 'en');
    expect(response.body.products[0]).toMatchObject({
      nutritionLocked: false,
      nutrition: { fat: { value: 30.9, unit: 'g' } },
    });
    expect(response.body.products[0].nutrition).toEqual({
      fat: { value: 30.9, unit: 'g' },
    });
    expect(response.body.products[0]).not.toHaveProperty('providerInternalField');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('prevents caches from retaining authoritative account entitlement', async () => {
    const response = await request(harness('active').app).get('/api/user');

    expect(response.status).toBe(200);
    expect(response.body.nutritionAccess).toBe(true);
    expect(response.body.billingAvailable).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports when optional Stripe Checkout is unavailable', async () => {
    const setup = harness();
    setup.dependencies.billing = null;

    const response = await request(createApp(setup.dependencies)).get('/api/user');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ nutritionAccess: false, billingAvailable: false });
  });

  it('fails closed when nutrition access is revoked during an upstream search', async () => {
    const setup = harness('active');
    vi.mocked(setup.dependencies.products.search).mockImplementationOnce(async () => {
      await setup.repository.processStripeEvent(setup.event, async () => ({
        ...setup.currentSubscription,
        status: 'canceled',
      } as Stripe.Subscription));
      return [{
        id: 'revoked', name: 'Revoked', brand: null, image: null,
        nutrition: { fat: { value: 30.9, unit: 'g' } },
      }];
    });

    const response = await search(setup.app, 'spread', 'en');

    expect(response.status).toBe(200);
    expect(response.body.products[0]).toMatchObject({ nutritionLocked: true });
    expect(response.body.products[0]).not.toHaveProperty('nutrition');
    expect(setup.repository.getDemoUser).toHaveBeenCalledTimes(2);
  });

  it('persists valid searches and returns recent entries', async () => {
    const { app, repository } = harness();
    await search(app, 'oat milk', 'nl');
    const recent = await request(app).get('/api/searches/recent');
    expect(repository.saveSearch).toHaveBeenCalledWith(DEMO_USER_ID, 'oat milk', 'nl');
    expect(recent.body.searches[0]).toMatchObject({ query: 'oat milk', locale: 'nl' });
  });

  it('does not persist a search when the authoritative entitlement recheck fails', async () => {
    const setup = harness('active');
    vi.mocked(setup.repository.getDemoUser)
      .mockResolvedValueOnce({ ...baseUser, subscriptionStatus: 'active' })
      .mockRejectedValueOnce(new Error('database unavailable'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await search(setup.app, 'spread', 'en');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Unexpected server error' });
    expect(setup.repository.saveSearch).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith('Unexpected request failure', {
      method: 'POST',
      path: '/api/products/search',
    });
    errorLog.mockRestore();
  });

  it('returns a safe upstream failure', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.products.search).mockRejectedValueOnce(new Error('secret upstream detail'));
    const response = await search(setup.app, 'milk', 'en');
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Product search is temporarily unavailable' });
  });

  it('forwards safe upstream backpressure without retrying in the API layer', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.products.search).mockRejectedValueOnce(new ProductProviderRateLimitError(17));

    const response = await search(setup.app, 'milk', 'en');

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.body).toEqual({ error: 'Product search is temporarily unavailable' });
  });

  it('synchronizes subscription events only after signature verification', async () => {
    const { app, repository, dependencies, event } = harness();
    const response = await request(app).post('/api/webhooks/stripe').set('stripe-signature', 'valid').set('content-type', 'application/json').send('{}');
    expect(response.status).toBe(200);
    expect(repository.processStripeEvent).toHaveBeenCalledOnce();
    expect(dependencies.billing!.retrieveSubscription).toHaveBeenCalledWith('sub_test');
    expect(repository.processStripeEvent).toHaveBeenCalledWith(event, expect.any(Function));
    expect((await request(app).get('/api/user')).body.nutritionAccess).toBe(true);
  });

  it('rejects an invalid webhook signature without processing it', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.billing!.constructEvent).mockImplementationOnce(() => { throw new Error('bad signature'); });
    const response = await request(setup.app).post('/api/webhooks/stripe').set('stripe-signature', 'invalid').set('content-type', 'application/json').send('{}');
    expect(response.status).toBe(400);
    expect(setup.repository.processStripeEvent).not.toHaveBeenCalled();
    expect(setup.dependencies.billing!.retrieveSubscription).not.toHaveBeenCalled();
  });

  it('acknowledges a verified duplicate without another Stripe read', async () => {
    const setup = harness();
    vi.mocked(setup.repository.isStripeEventProcessed).mockResolvedValueOnce(true);

    const response = await request(setup.app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(200);
    expect(setup.dependencies.billing!.retrieveSubscription).not.toHaveBeenCalled();
    expect(setup.repository.processStripeEvent).not.toHaveBeenCalled();
  });

  it('acknowledges an irrelevant verified event without Stripe or database work', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.billing!.constructEvent).mockReturnValueOnce({
      id: 'evt_irrelevant',
      type: 'customer.created',
      data: { object: {} },
    } as Stripe.Event);

    const response = await request(setup.app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(200);
    expect(setup.repository.isStripeEventProcessed).not.toHaveBeenCalled();
    expect(setup.dependencies.billing!.retrieveSubscription).not.toHaveBeenCalled();
    expect(setup.repository.processStripeEvent).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    '',
    `evt_${'x'.repeat(188)}`,
  ])('acknowledges a verified relevant event with unusable id %p without durable work', async (id) => {
    const setup = harness();
    vi.mocked(setup.dependencies.billing!.constructEvent).mockReturnValueOnce({
      id,
      type: 'customer.subscription.updated',
      data: { object: setup.currentSubscription },
    } as unknown as Stripe.Event);

    const response = await request(setup.app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(setup.repository.isStripeEventProcessed).not.toHaveBeenCalled();
    expect(setup.repository.processStripeEvent).not.toHaveBeenCalled();
    expect(setup.dependencies.billing!.retrieveSubscription).not.toHaveBeenCalled();
  });

  it('returns a retryable failure when current Stripe state cannot be loaded durably', async () => {
    const setup = harness();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(setup.dependencies.billing!.retrieveSubscription).mockRejectedValueOnce(new Error('sk_test_must_not_be_logged'));

    const response = await request(setup.app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Unexpected server error' });
    expect(setup.repository.processStripeEvent).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith('Unexpected request failure', {
      method: 'POST',
      path: '/api/webhooks/stripe',
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('sk_test_must_not_be_logged');
    errorLog.mockRestore();
  });
});
