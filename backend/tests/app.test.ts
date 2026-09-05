import type Stripe from 'stripe';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDependencies } from '../src/app.js';
import { DEMO_USER_ID, type Locale } from '../src/constants.js';
import { ProductProviderRateLimitError } from '../src/open-food-facts.js';
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
    processStripeEvent: vi.fn(async (event: Stripe.Event, currentSubscription?: Stripe.Subscription) => {
      if (event.type === 'customer.subscription.updated') {
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

describe('Foodscope API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects blank searches and unsupported locales', async () => {
    const { app } = harness();
    expect((await request(app).get('/api/products/search?q=%20&lang=en')).status).toBe(400);
    expect((await request(app).get('/api/products/search?q=milk&lang=es')).status).toBe(400);
  });

  it('never sends nutrition to an inactive user', async () => {
    const response = await request(harness().app).get('/api/products/search?q=spread&lang=en');
    expect(response.status).toBe(200);
    expect(response.body.products[0]).toMatchObject({ nutritionLocked: true });
    expect(response.body.products[0]).not.toHaveProperty('nutrition');
  });

  it('sends only available normalized nutrition to an active user', async () => {
    const response = await request(harness('active').app).get('/api/products/search?q=spread&lang=en');
    expect(response.body.products[0]).toMatchObject({
      nutritionLocked: false,
      nutrition: { fat: { value: 30.9, unit: 'g' }, sugars: { value: 56.3, unit: 'g' } },
    });
  });

  it('persists valid searches and returns recent entries', async () => {
    const { app, repository } = harness();
    await request(app).get('/api/products/search?q=oat%20milk&lang=nl');
    const recent = await request(app).get('/api/searches/recent');
    expect(repository.saveSearch).toHaveBeenCalledWith(DEMO_USER_ID, 'oat milk', 'nl');
    expect(recent.body.searches[0]).toMatchObject({ query: 'oat milk', locale: 'nl' });
  });

  it('returns a safe upstream failure', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.products.search).mockRejectedValueOnce(new Error('secret upstream detail'));
    const response = await request(setup.app).get('/api/products/search?q=milk&lang=en');
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Product search is temporarily unavailable' });
  });

  it('forwards safe upstream backpressure without retrying in the API layer', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.products.search).mockRejectedValueOnce(new ProductProviderRateLimitError(17));

    const response = await request(setup.app).get('/api/products/search?q=milk&lang=en');

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.body).toEqual({ error: 'Product search is temporarily unavailable' });
  });

  it('synchronizes subscription events only after signature verification', async () => {
    const { app, repository, dependencies, event, currentSubscription } = harness();
    const response = await request(app).post('/api/webhooks/stripe').set('stripe-signature', 'valid').set('content-type', 'application/json').send('{}');
    expect(response.status).toBe(200);
    expect(repository.processStripeEvent).toHaveBeenCalledOnce();
    expect(dependencies.billing!.retrieveSubscription).toHaveBeenCalledWith('sub_test');
    expect(repository.processStripeEvent).toHaveBeenCalledWith(event, currentSubscription);
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

  it('returns a retryable failure without processing when current Stripe state cannot be loaded', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.billing!.retrieveSubscription).mockRejectedValueOnce(new Error('Stripe unavailable'));

    const response = await request(setup.app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Unexpected server error' });
    expect(setup.repository.processStripeEvent).not.toHaveBeenCalled();
  });
});
