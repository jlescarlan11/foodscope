import type Stripe from 'stripe';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDependencies } from '../src/app.js';
import { DEMO_USER_ID, type Locale } from '../src/constants.js';
import { ProductProviderRateLimitError } from '../src/open-food-facts.js';
import { CheckoutUnavailableError } from '../src/errors.js';
import type { DemoUser, RecentSearch, Repository } from '../src/types.js';

const baseUser: DemoUser = {
  id: DEMO_USER_ID, email: 'demo@foodscope.local', stripeCustomerId: null,
  stripeSubscriptionId: null, stripeCheckoutAttemptId: null, stripeCheckoutSessionId: null,
  stripeCheckoutSessionUrl: null, stripeCheckoutExpiresAt: null,
  subscriptionStatus: 'inactive', subscriptionCurrentPeriodEnd: null,
};

function harness(status = 'inactive') {
  let user = {
    ...baseUser,
    subscriptionStatus: status,
    subscriptionCurrentPeriodEnd: status === 'active' || status === 'trialing'
      ? new Date('2100-01-01T00:00:00.000Z')
      : null,
  };
  const searches: RecentSearch[] = [];
  const repository: Repository = {
    getDemoUser: vi.fn(async () => user),
    getDemoUserForCheckout: vi.fn(async () => user),
    saveSearch: vi.fn(async (_userId: string, _requestId: string, query: string, locale: Locale) => {
      searches.unshift({ id: searches.length + 1, query, locale, createdAt: new Date() });
    }),
    getRecentSearches: vi.fn(async (_userId: string, limit: number) => searches.slice(0, limit)),
    setStripeCustomer: vi.fn(async (_userId: string, customerId: string) => { user = { ...user, stripeCustomerId: customerId }; }),
    getOrCreateCheckoutAttempt: vi.fn(async () => ({ id: 'attempt_test', expiresAt: new Date(), sessionUrl: null })),
    completeCheckoutAttempt: vi.fn(async () => undefined),
    processStripeEvent: vi.fn(async (
      event: Stripe.Event,
      retrieveSubscription?: (subscriptionId: string) => Promise<Stripe.Subscription>,
    ) => {
      if (event.type === 'customer.subscription.updated') {
        const currentSubscription = await retrieveSubscription!((event.data.object as Stripe.Subscription).id);
        user = {
          ...user,
          subscriptionStatus: currentSubscription!.status,
          subscriptionCurrentPeriodEnd: new Date(4_102_444_800_000),
        };
      }
    }),
  };
  const product = {
    id: '3017620422003', name: 'Hazelnut spread', brand: null, image: null,
    nutrition: { fat: { value: 30.9, unit: 'g' as const }, sugars: { value: 56.3, unit: 'g' as const } },
  };
  const event = {
    id: 'evt_test',
    type: 'customer.subscription.updated',
    livemode: false,
    data: { object: { id: 'sub_test', status: 'canceled' } },
  } as unknown as Stripe.Event;
  const currentSubscription = { id: 'sub_test', status: 'active' } as Stripe.Subscription;
  const dependencies: AppDependencies = {
    config: { port: 4000, host: '127.0.0.1', frontendUrl: 'http://localhost:3000', openFoodFactsUserAgent: 'test' },
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

function search(
  app: ReturnType<typeof createApp>,
  q: string,
  lang: string,
  requestId = '00000000-0000-4000-8000-000000000002',
) {
  return request(app)
    .post('/api/products/search')
    .set('origin', 'http://localhost:3000')
    .send({ requestId, q, lang });
}

describe('Foodscope API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects blank searches and missing or unsupported locales', async () => {
    const setup = harness();
    const { app } = setup;
    expect((await search(app, ' ', 'en')).status).toBe(400);
    expect((await search(app, 'milk', 'es')).status).toBe(400);
    expect((await search(app, 'milk', 'en', 'not-a-request-id')).status).toBe(400);
    expect((await request(app)
      .post('/api/products/search')
      .set('origin', 'http://localhost:3000')
      .send({ requestId: '00000000-0000-4000-8000-000000000002', q: 'milk' })).status)
      .toBe(400);
    expect(setup.dependencies.products.search).not.toHaveBeenCalled();
    expect(setup.repository.saveSearch).not.toHaveBeenCalled();
  });

  it('rejects passive and cross-site search requests before provider work', async () => {
    const setup = harness();

    const legacyGet = await request(setup.app).get('/api/products/search?q=milk&lang=en');
    const untrustedOrigin = await request(setup.app)
      .post('/api/products/search')
      .set('origin', 'https://attacker.example')
      .send({ requestId: '00000000-0000-4000-8000-000000000002', q: 'milk', lang: 'en' });

    expect(legacyGet.status).toBe(404);
    expect(untrustedOrigin.status).toBe(403);
    expect(setup.dependencies.products.search).not.toHaveBeenCalled();
    expect(setup.repository.saveSearch).not.toHaveBeenCalled();
  });

  it('cancels provider work and skips history when the response connection closes', async () => {
    const setup = harness();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let startedSearch: (() => void) | undefined;
    const searchStarted = new Promise<void>((resolve) => { startedSearch = resolve; });
    let providerSignal: AbortSignal | undefined;
    setup.dependencies.products.search = vi.fn(async (_query, _locale, signal) => {
      providerSignal = signal;
      startedSearch?.();
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return [];
    });
    const server = setup.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${address.port}/api/products/search`, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000002',
          q: 'milk',
          lang: 'en',
        }),
        signal: controller.signal,
      }).catch(() => undefined);

      await searchStarted;
      controller.abort();
      await response;

      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
      expect(setup.repository.saveSearch).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not start provider work after disconnecting during the initial account read', async () => {
    const setup = harness();
    let accountReadStarted: (() => void) | undefined;
    let releaseAccountRead: (() => void) | undefined;
    const accountRead = new Promise<void>((resolve) => { accountReadStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseAccountRead = resolve; });
    vi.mocked(setup.repository.getDemoUser).mockImplementationOnce(async () => {
      accountReadStarted?.();
      await release;
      return baseUser;
    });
    const server = setup.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const connectionClosed = new Promise<void>((resolve) => {
      server.once('connection', (socket) => socket.once('close', () => resolve()));
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${address.port}/api/products/search`, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000002',
          q: 'milk',
          lang: 'en',
        }),
        signal: controller.signal,
      }).catch(() => undefined);

      await accountRead;
      controller.abort();
      await response;
      await connectionClosed;
      releaseAccountRead?.();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(setup.dependencies.products.search).not.toHaveBeenCalled();
      expect(setup.repository.saveSearch).not.toHaveBeenCalled();
    } finally {
      releaseAccountRead?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('skips history when the response closes during the entitlement recheck', async () => {
    const setup = harness('active');
    let providerSignal: AbortSignal | undefined;
    vi.mocked(setup.dependencies.products.search).mockImplementation(async (_query, _locale, signal) => {
      providerSignal = signal;
      return [{
        id: 'cancelled', name: 'Cancelled', brand: null, image: null,
        nutrition: { fat: { value: 1, unit: 'g' } },
      }];
    });
    let userReads = 0;
    let recheckStarted: (() => void) | undefined;
    let releaseRecheck: (() => void) | undefined;
    const recheck = new Promise<void>((resolve) => { recheckStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseRecheck = resolve; });
    vi.mocked(setup.repository.getDemoUser).mockImplementation(async () => {
      userReads += 1;
      if (userReads === 2) {
        recheckStarted?.();
        await release;
      }
      return { ...baseUser, subscriptionStatus: 'active', subscriptionCurrentPeriodEnd: new Date('2100-01-01') };
    });
    const server = setup.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${address.port}/api/products/search`, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: '00000000-0000-4000-8000-000000000002',
          q: 'milk',
          lang: 'en',
        }),
        signal: controller.signal,
      }).catch(() => undefined);

      await recheck;
      controller.abort();
      await response;
      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
      releaseRecheck?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(userReads).toBe(2);
      expect(setup.repository.saveSearch).not.toHaveBeenCalled();
    } finally {
      releaseRecheck?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('classifies malformed and oversized JSON as non-retryable client errors', async () => {
    const setup = harness();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const malformed = await request(setup.app)
      .post('/api/billing/checkout-session')
      .set('origin', setup.dependencies.config.frontendUrl)
      .set('content-type', 'application/json')
      .send('{');
    const oversized = await request(setup.app)
      .post('/api/billing/checkout-session')
      .set('origin', setup.dependencies.config.frontendUrl)
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
      .set('origin', 'https://attacker.example')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(101 * 1024) }));

    expect(missingOrigin.status).toBe(403);
    expect(untrustedOrigin.status).toBe(403);
    expect(setup.repository.getDemoUserForCheckout).not.toHaveBeenCalled();
    expect(setup.dependencies.billing!.createCheckout).not.toHaveBeenCalled();
  });

  it('does not start Stripe work after disconnecting during the Checkout account read', async () => {
    const setup = harness();
    let accountReadStarted: (() => void) | undefined;
    let releaseAccountRead: (() => void) | undefined;
    const accountRead = new Promise<void>((resolve) => { accountReadStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseAccountRead = resolve; });
    vi.mocked(setup.repository.getDemoUserForCheckout).mockImplementationOnce(async () => {
      accountReadStarted?.();
      await release;
      return baseUser;
    });
    const server = setup.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const connectionClosed = new Promise<void>((resolve) => {
      server.once('connection', (socket) => socket.once('close', () => resolve()));
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${address.port}/api/billing/checkout-session`, {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        signal: controller.signal,
      }).catch(() => undefined);

      await accountRead;
      controller.abort();
      await response;
      await connectionClosed;
      releaseAccountRead?.();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(setup.dependencies.billing!.createCheckout).not.toHaveBeenCalled();
    } finally {
      releaseAccountRead?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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
      .mockRejectedValueOnce(new CheckoutUnavailableError());

    const response = await request(setup.app)
      .post('/api/billing/checkout-session')
      .set('origin', setup.dependencies.config.frontendUrl);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Checkout is unavailable for the current subscription state',
    });
  });

  it('logs a value-free signal when Checkout creation fails unexpectedly', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.billing!.createCheckout)
      .mockRejectedValueOnce(new Error('secret Stripe detail'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(setup.app)
      .post('/api/billing/checkout-session')
      .set('origin', setup.dependencies.config.frontendUrl);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Unable to start Checkout' });
    expect(errorLog).toHaveBeenCalledWith('Checkout provider failed');
    expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining('secret Stripe detail'));
    errorLog.mockRestore();
  });

  it('never sends nutrition to an inactive user', async () => {
    const response = await search(harness().app, 'spread', 'en');
    expect(response.status).toBe(200);
    expect(response.body.products[0]).toMatchObject({ nutritionLocked: true });
    expect(response.body.products[0]).not.toHaveProperty('nutrition');
    expect(response.body.account).toEqual({
      nutritionAccess: false,
      billingAvailable: true,
      checkoutAvailable: true,
    });
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
    expect(response.body).not.toHaveProperty('account');
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
    expect(response.body.account).toEqual({
      nutritionAccess: true,
      billingAvailable: true,
      checkoutAvailable: false,
    });
    expect(response.body.products[0]).not.toHaveProperty('providerInternalField');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each([null, new Date(Number.NaN), new Date('2000-01-01T00:00:00.000Z')])(
    'fails closed for active entitlement with stale period %s',
    async (subscriptionCurrentPeriodEnd) => {
      const setup = harness('active');
      vi.mocked(setup.repository.getDemoUser).mockResolvedValue({
        ...baseUser,
        subscriptionStatus: 'active',
        subscriptionCurrentPeriodEnd,
      });

      const account = await request(setup.app).get('/api/user');
      const products = await search(setup.app, 'spread', 'en');

      expect(account.body.nutritionAccess).toBe(false);
      expect(products.body.products[0]).toMatchObject({ nutritionLocked: true });
      expect(products.body.products[0]).not.toHaveProperty('nutrition');
    },
  );

  it('prevents caches from retaining authoritative account entitlement', async () => {
    const response = await request(harness('active').app).get('/api/user');

    expect(response.status).toBe(200);
    expect(response.body.nutritionAccess).toBe(true);
    expect(response.body.billingAvailable).toBe(true);
    expect(response.body.checkoutAvailable).toBe(false);
    expect(response.body).not.toHaveProperty('email');
    expect(response.body).not.toHaveProperty('subscriptionStatus');
    expect(response.body).not.toHaveProperty('subscriptionCurrentPeriodEnd');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports when optional Stripe Checkout is unavailable', async () => {
    const setup = harness();
    setup.dependencies.billing = null;

    const response = await request(createApp(setup.dependencies)).get('/api/user');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      nutritionAccess: false,
      billingAvailable: false,
      checkoutAvailable: false,
    });
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'unknown'])(
    'rejects Checkout without provider work for non-eligible %s state',
    async (status) => {
      const setup = harness(status);

      const account = await request(setup.app).get('/api/user');
      const response = await request(setup.app)
        .post('/api/billing/checkout-session')
        .set('origin', setup.dependencies.config.frontendUrl);

      expect(account.body.checkoutAvailable).toBe(false);
      expect(response.status).toBe(409);
      expect(setup.dependencies.billing!.createCheckout).not.toHaveBeenCalled();
    },
  );

  it.each(['inactive', 'canceled', 'incomplete_expired'])(
    'offers Checkout recovery for eligible %s state',
    async (status) => {
      const setup = harness(status);

      const account = await request(setup.app).get('/api/user');
      const response = await request(setup.app)
        .post('/api/billing/checkout-session')
        .set('origin', setup.dependencies.config.frontendUrl);

      expect(account.body.checkoutAvailable).toBe(true);
      expect(response.status).toBe(201);
      expect(setup.dependencies.billing!.createCheckout).toHaveBeenCalledOnce();
    },
  );

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
    expect(response.body.account).toEqual({
      nutritionAccess: false,
      billingAvailable: true,
      checkoutAvailable: true,
    });
    expect(setup.repository.getDemoUser).toHaveBeenCalledTimes(2);
  });

  it('persists valid searches and returns recent entries', async () => {
    const { app, repository } = harness();
    await search(app, 'oat milk', 'nl');
    const recent = await request(app).get('/api/searches/recent');
    expect(repository.saveSearch).toHaveBeenCalledWith(
      DEMO_USER_ID,
      '00000000-0000-4000-8000-000000000002',
      'oat milk',
      'nl',
    );
    expect(recent.body.searches[0]).toMatchObject({ query: 'oat milk', locale: 'nl' });
    expect(recent.body.searches[0]).not.toHaveProperty('id');
    expect(recent.body.searches[0]).not.toHaveProperty('createdAt');
  });

  it('omits malformed legacy history without hiding valid entries', async () => {
    const setup = harness();
    vi.mocked(setup.repository.getRecentSearches).mockResolvedValueOnce([
      { id: 1, query: 'valid', locale: 'fr', createdAt: new Date() },
      { id: 2, query: 'invalid locale', locale: 'es', createdAt: new Date() },
      { id: 3, query: ' '.repeat(5), locale: 'en', createdAt: new Date() },
      { id: 4, query: 'x'.repeat(121), locale: 'en', createdAt: new Date() },
    ]);

    const response = await request(setup.app).get('/api/searches/recent');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ searches: [{ query: 'valid', locale: 'fr' }] });
  });

  it('does not query history after disconnecting during the recent-search account read', async () => {
    const setup = harness();
    let accountReadStarted: (() => void) | undefined;
    let releaseAccountRead: (() => void) | undefined;
    const accountRead = new Promise<void>((resolve) => { accountReadStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseAccountRead = resolve; });
    vi.mocked(setup.repository.getDemoUser).mockImplementationOnce(async () => {
      accountReadStarted?.();
      await release;
      return baseUser;
    });
    const server = setup.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const connectionClosed = new Promise<void>((resolve) => {
      server.once('connection', (socket) => socket.once('close', () => resolve()));
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${address.port}/api/searches/recent`, {
        signal: controller.signal,
      }).catch(() => undefined);

      await accountRead;
      controller.abort();
      await response;
      await connectionClosed;
      releaseAccountRead?.();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(setup.repository.getRecentSearches).not.toHaveBeenCalled();
    } finally {
      releaseAccountRead?.();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await search(setup.app, 'milk', 'en');
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Product search is temporarily unavailable' });
    expect(errorLog).toHaveBeenCalledWith('Product search provider failed');
    expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining('secret upstream detail'));
    errorLog.mockRestore();
  });

  it('forwards safe upstream backpressure without retrying in the API layer', async () => {
    const setup = harness();
    vi.mocked(setup.dependencies.products.search).mockRejectedValueOnce(new ProductProviderRateLimitError(17));

    const response = await search(setup.app, 'milk', 'en');

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.body).toEqual({ error: 'Product search is temporarily unavailable' });
  });

  it.each([Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5])(
    'does not emit malformed Retry-After metadata %s',
    async (retryAfterSeconds) => {
      const setup = harness();
      vi.mocked(setup.dependencies.products.search).mockRejectedValueOnce(
        new ProductProviderRateLimitError(retryAfterSeconds),
      );

      const response = await search(setup.app, 'milk', 'en');

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBeUndefined();
    },
  );

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

  it('rejects an unsigned webhook before buffering its oversized body', async () => {
    const setup = harness();

    const response = await request(setup.app)
      .post('/api/webhooks/stripe')
      .set('content-type', 'application/json')
      .send('x'.repeat(101 * 1024));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid webhook request' });
    expect(setup.dependencies.billing!.constructEvent).not.toHaveBeenCalled();
    expect(setup.repository.processStripeEvent).not.toHaveBeenCalled();
  });

  it('acknowledges a verified duplicate without another Stripe read', async () => {
    const setup = harness();
    vi.mocked(setup.repository.processStripeEvent).mockResolvedValueOnce(undefined);

    const response = await request(setup.app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(200);
    expect(setup.dependencies.billing!.retrieveSubscription).not.toHaveBeenCalled();
    expect(setup.repository.processStripeEvent).toHaveBeenCalledOnce();
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
    expect(setup.repository.processStripeEvent).not.toHaveBeenCalled();
    expect(setup.dependencies.billing!.retrieveSubscription).not.toHaveBeenCalled();
  });

  it.each([true, undefined])(
    'acknowledges a relevant event with unsupported livemode %p without durable work',
    async (livemode) => {
      const setup = harness();
      vi.mocked(setup.dependencies.billing!.constructEvent).mockReturnValueOnce({
        ...setup.event,
        livemode,
      } as Stripe.Event);

      const response = await request(setup.app)
        .post('/api/webhooks/stripe')
        .set('stripe-signature', 'valid')
        .set('content-type', 'application/json')
        .send('{}');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ received: true });
      expect(setup.repository.processStripeEvent).not.toHaveBeenCalled();
      expect(setup.dependencies.billing!.retrieveSubscription).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    '',
    'x'.repeat(256),
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
    expect(setup.repository.processStripeEvent).not.toHaveBeenCalled();
    expect(setup.dependencies.billing!.retrieveSubscription).not.toHaveBeenCalled();
  });

  it('processes a verified opaque event ID at Stripe\'s documented maximum length', async () => {
    const setup = harness();
    const event = { ...setup.event, id: 'x'.repeat(255) } as Stripe.Event;
    vi.mocked(setup.dependencies.billing!.constructEvent).mockReturnValueOnce(event);

    const response = await request(setup.app)
      .post('/api/webhooks/stripe')
      .set('stripe-signature', 'valid')
      .set('content-type', 'application/json')
      .send('{}');

    expect(response.status).toBe(200);
    expect(setup.repository.processStripeEvent).toHaveBeenCalledWith(event, expect.any(Function));
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
