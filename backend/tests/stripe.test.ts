import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { createBillingProvider, StripeBillingProvider } from '../src/stripe.js';
import { DEMO_USER_ID } from '../src/constants.js';
import { CheckoutUnavailableError } from '../src/errors.js';
import type { DemoUser, Repository } from '../src/types.js';

const user: DemoUser = {
  id: DEMO_USER_ID,
  email: 'demo@foodscope.local',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripeCheckoutAttemptId: null,
  stripeCheckoutSessionId: null,
  stripeCheckoutSessionUrl: null,
  stripeCheckoutExpiresAt: null,
  subscriptionStatus: 'inactive',
  subscriptionCurrentPeriodEnd: null,
};

function harness(sessionUrl: string | null = null, customerId: string | null = null) {
  const attempt = {
    id: '00000000-0000-4000-8000-000000000099',
    expiresAt: new Date('2030-01-01T00:31:00Z'),
    sessionUrl,
    priceId: 'price_test',
    customerId,
  };
  const repository = {
    getOrCreateCheckoutAttempt: vi.fn(async () => attempt),
    setStripeCustomer: vi.fn(async () => undefined),
    replaceStripeCustomer: vi.fn(async (
      _userId: string,
      _expectedCustomerId: string,
      _expectedCheckoutAttemptId: string,
      replacementCustomerId: string,
    ) =>
      replacementCustomerId),
    completeCheckoutAttempt: vi.fn(async () => undefined),
    releaseCheckoutAttempt: vi.fn(async () => undefined),
  } as unknown as Repository;
  const customersCreate = vi.fn(async (
    params?: unknown,
    options?: { idempotencyKey?: string },
  ): Promise<Record<string, unknown>> => {
    void params;
    void options;
    return {
      id: 'cus_test',
      object: 'customer',
      livemode: false,
      metadata: { demoUserId: user.id },
    };
  });
  const customersRetrieve = vi.fn(async (id: string): Promise<{
    id: string;
    object: string;
    deleted: boolean;
    livemode?: boolean;
    metadata?: Record<string, unknown>;
  }> => ({
    id,
    object: 'customer',
    deleted: false,
    livemode: false,
    metadata: { demoUserId: user.id },
  }));
  const session = {
    id: 'cs_test',
    object: 'checkout.session',
    url: 'https://checkout.stripe.test/session',
    expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
    livemode: false,
    mode: 'subscription',
    status: 'open',
    customer: customerId ?? 'cus_test',
    metadata: { demoUserId: user.id },
  };
  const sessionsCreate = vi.fn(async (
    params?: { customer?: string },
  ): Promise<Record<string, unknown>> => ({
    ...session,
    customer: params?.customer ?? session.customer,
  }));
  const subscriptionsList = vi.fn(async (): Promise<Record<string, unknown>> => ({
    data: [],
    has_more: false,
  }));
  const pricesRetrieve = vi.fn(async () => ({
    id: 'price_test',
    object: 'price',
    active: true,
    livemode: false,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1 },
  }));
  const stripe = {
    customers: { create: customersCreate, retrieve: customersRetrieve },
    checkout: { sessions: { create: sessionsCreate } },
    subscriptions: { list: subscriptionsList },
    prices: { retrieve: pricesRetrieve },
  } as unknown as Stripe;
  const provider = new StripeBillingProvider({
    port: 4000,
    host: '127.0.0.1',
    frontendUrl: 'http://localhost:3000',
    openFoodFactsUserAgent: 'test',
    stripeSecretKey: 'sk_test_fake',
    stripePriceId: 'price_test',
  }, repository, stripe);
  return {
    provider,
    repository,
    customersCreate,
    customersRetrieve,
    sessionsCreate,
    subscriptionsList,
    pricesRetrieve,
    attempt,
    session,
  };
}

describe('Stripe Checkout creation', () => {
  it('disables billing only when every Stripe setting is absent', () => {
    expect(createBillingProvider({
      port: 4000,
      host: '127.0.0.1',
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'test',
    }, {} as Repository)).toBeNull();
  });

  it('refuses partial Stripe configuration', () => {
    expect(() => createBillingProvider({
      port: 4000,
      host: '127.0.0.1',
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'test',
      stripeSecretKey: 'sk_test_incomplete',
    }, {} as Repository)).toThrow('requires a test key, webhook secret, and Price ID');
  });

  it('refuses to initialize with a live-mode key', () => {
    expect(() => createBillingProvider({
      port: 4000,
      host: '127.0.0.1',
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'test',
      stripeSecretKey: 'sk_live_forbidden',
      stripeWebhookSecret: 'whsec_fake',
      stripePriceId: 'price_fake',
    }, {} as Repository)).toThrow('only supports Stripe test mode');
  });

  it('refuses malformed complete Stripe configuration at the provider boundary', () => {
    expect(() => createBillingProvider({
      port: 4000,
      host: '127.0.0.1',
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'test',
      stripeSecretKey: 'sk_test_fake',
      stripeWebhookSecret: 'whsec_fake extra',
      stripePriceId: 'price_fake',
    }, {} as Repository)).toThrow('invalid webhook secret or Price ID');
  });

  it('accepts a least-privilege restricted test key', () => {
    expect(createBillingProvider({
      port: 4000,
      host: '127.0.0.1',
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'test',
      stripeSecretKey: 'rk_test_fake',
      stripeWebhookSecret: 'whsec_fake',
      stripePriceId: 'price_fake',
    }, {} as Repository)).toBeInstanceOf(StripeBillingProvider);
  });

  it('uses stable idempotency keys and durably saves the reusable Session', async () => {
    const setup = harness();

    await expect(setup.provider.createCheckout(user)).resolves.toEqual({
      url: 'https://checkout.stripe.test/session',
    });

    expect(setup.customersCreate).toHaveBeenCalledWith(expect.anything(), {
      idempotencyKey: 'foodscope-demo-customer-v1',
    });
    expect(setup.sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test',
        expires_at: Math.floor(setup.attempt.expiresAt.getTime() / 1000),
        integration_identifier: expect.stringMatching(/^foodscope_[a-z]{8}$/),
        subscription_data: { metadata: { demoUserId: user.id, checkoutAttemptId: setup.attempt.id } },
      }),
      { idempotencyKey: `foodscope-checkout-${setup.attempt.id}` },
    );
    expect(setup.repository.completeCheckoutAttempt).toHaveBeenCalledWith(user.id, setup.attempt.id, {
      id: 'cs_test',
      url: 'https://checkout.stripe.test/session',
      expiresAt: setup.attempt.expiresAt,
    });
  });

  it('rejects a configured Price that is not monthly before creating resources', async () => {
    const setup = harness();
    setup.pricesRetrieve.mockResolvedValueOnce({
      id: 'price_test',
      object: 'price',
      active: true,
      livemode: false,
      type: 'recurring',
      recurring: { interval: 'year', interval_count: 1 },
    });

    await expect(setup.provider.createCheckout(user)).rejects.toThrow(
      'Stripe Price does not match the Foodscope monthly plan',
    );
    await expect(setup.provider.createCheckout(user)).rejects.toThrow(
      'Stripe Price does not match the Foodscope monthly plan',
    );
    expect(setup.pricesRetrieve).toHaveBeenCalledOnce();
    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.subscriptionsList).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });

  it('rejects an inactive monthly Price before creating resources', async () => {
    const setup = harness();
    setup.pricesRetrieve.mockResolvedValueOnce({
      id: 'price_test',
      object: 'price',
      active: false,
      livemode: false,
      type: 'recurring',
      recurring: { interval: 'month', interval_count: 1 },
    });

    await expect(setup.provider.createCheckout(user)).rejects.toThrow(
      'Stripe Price is unavailable for new Foodscope purchases',
    );
    expect(setup.pricesRetrieve).toHaveBeenCalledOnce();
    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });

  it('retries a transient Price read without creating resources on the failed attempt', async () => {
    const setup = harness();
    setup.pricesRetrieve.mockRejectedValueOnce(new Error('temporary Price read failure'));

    await expect(setup.provider.createCheckout(user)).rejects.toThrow(
      'temporary Price read failure',
    );
    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();

    await expect(setup.provider.createCheckout(user)).resolves.toEqual({
      url: 'https://checkout.stripe.test/session',
    });
    expect(setup.pricesRetrieve).toHaveBeenCalledTimes(2);
    expect(setup.customersCreate).toHaveBeenCalledOnce();
    expect(setup.sessionsCreate).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent Checkout requests before calling Stripe', async () => {
    const setup = harness();

    await expect(Promise.all([
      setup.provider.createCheckout(user),
      setup.provider.createCheckout(user),
    ])).resolves.toEqual([
      { url: 'https://checkout.stripe.test/session' },
      { url: 'https://checkout.stripe.test/session' },
    ]);

    expect(setup.repository.getOrCreateCheckoutAttempt).toHaveBeenCalledOnce();
    expect(setup.pricesRetrieve).toHaveBeenCalledOnce();
    expect(setup.customersCreate).toHaveBeenCalledOnce();
    expect(setup.sessionsCreate).toHaveBeenCalledOnce();
    expect(setup.repository.completeCheckoutAttempt).toHaveBeenCalledOnce();
  });

  it('allows a new Checkout attempt after a coalesced request fails', async () => {
    const setup = harness();
    setup.customersCreate.mockRejectedValueOnce(new Error('temporary provider failure'));

    const failed = await Promise.allSettled([
      setup.provider.createCheckout(user),
      setup.provider.createCheckout(user),
    ]);
    expect(failed.map(({ status }) => status)).toEqual(['rejected', 'rejected']);

    await expect(setup.provider.createCheckout(user)).resolves.toEqual({
      url: 'https://checkout.stripe.test/session',
    });
    expect(setup.repository.getOrCreateCheckoutAttempt).toHaveBeenCalledTimes(2);
    expect(setup.customersCreate).toHaveBeenCalledTimes(2);
    expect(setup.sessionsCreate).toHaveBeenCalledOnce();
  });

  it.each([
    { object: 'invoice' },
    { id: '' },
    { id: 'c'.repeat(256) },
    { livemode: true },
    { metadata: {} },
    { metadata: { demoUserId: 'unexpected-user' } },
  ])('does not persist a contract-invalid new Customer %#', async (override) => {
    const setup = harness();
    setup.customersCreate.mockResolvedValueOnce({
      id: 'cus_test',
      object: 'customer',
      livemode: false,
      metadata: { demoUserId: user.id },
      ...override,
    });

    await expect(setup.provider.createCheckout(user)).rejects.toThrow(
      'valid Stripe Customer',
    );
    expect(setup.repository.setStripeCustomer).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });

  it('returns a stored open Session without creating any Stripe resource', async () => {
    const setup = harness('https://checkout.stripe.test/existing', 'cus_existing');

    await expect(setup.provider.createCheckout(user)).resolves.toEqual({
      url: 'https://checkout.stripe.test/existing',
    });
    expect(setup.pricesRetrieve).toHaveBeenCalledOnce();
    expect(setup.customersRetrieve).toHaveBeenCalledWith('cus_existing');
    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });

  it('does not return a stored Session without its authoritative Customer mapping', async () => {
    const setup = harness('https://checkout.stripe.test/unmapped');

    await expect(setup.provider.createCheckout(user)).rejects.toBeInstanceOf(
      CheckoutUnavailableError,
    );
    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });

  it.each([
    { object: 'invoice', livemode: false, metadata: { demoUserId: user.id } },
    { livemode: false, metadata: {} },
    { livemode: false, metadata: { demoUserId: 'unexpected-user' } },
    { livemode: true, metadata: { demoUserId: user.id } },
  ])('does not expose a stored Session for a misattributed Customer %#', async (customer) => {
    const setup = harness('https://checkout.stripe.test/misattributed', 'cus_other');
    setup.customersRetrieve.mockResolvedValueOnce({
      id: 'cus_other',
      object: 'customer',
      deleted: false,
      ...customer,
    });

    await expect(setup.provider.createCheckout(user)).rejects.toBeInstanceOf(
      CheckoutUnavailableError,
    );
    expect(setup.subscriptionsList).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });

  it('never returns a stored Session created for a different configured Price', async () => {
    const setup = harness('https://checkout.stripe.test/old-price');
    setup.attempt.priceId = 'price_previous';

    await expect(setup.provider.createCheckout(user)).rejects.toBeInstanceOf(
      CheckoutUnavailableError,
    );
    expect(setup.pricesRetrieve).not.toHaveBeenCalled();
    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });

  it('does not return a stored Session tied to a deleted Customer', async () => {
    const setup = harness('https://checkout.stripe.test/deleted-customer', 'cus_deleted');
    const replacementAttempt = {
      ...setup.attempt,
      id: '00000000-0000-4000-8000-000000000101',
      sessionUrl: null,
      customerId: 'cus_test',
    };
    vi.mocked(setup.repository.getOrCreateCheckoutAttempt)
      .mockResolvedValueOnce(setup.attempt)
      .mockResolvedValueOnce(replacementAttempt);
    setup.customersRetrieve.mockImplementation(async (id) =>
      id === 'cus_deleted'
        ? { id, object: 'customer', deleted: true }
        : {
          id, object: 'customer', deleted: false, livemode: false,
          metadata: { demoUserId: user.id },
        });

    await expect(setup.provider.createCheckout({
      ...user,
      stripeCustomerId: 'cus_stale_snapshot',
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/session' });

    expect(setup.customersRetrieve).toHaveBeenCalledWith('cus_deleted');
    expect(setup.repository.replaceStripeCustomer).toHaveBeenCalledWith(
      user.id,
      'cus_deleted',
      setup.attempt.id,
      'cus_test',
    );
    expect(setup.sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_test' }),
      { idempotencyKey: `foodscope-checkout-${replacementAttempt.id}` },
    );
  });

  it('does not replace a non-Customer object marked as deleted', async () => {
    const setup = harness(null, 'cus_existing');
    setup.customersRetrieve.mockResolvedValueOnce({
      id: 'cus_existing', object: 'invoice', deleted: true,
    });

    await expect(setup.provider.createCheckout({
      ...user,
      stripeCustomerId: 'cus_existing',
    })).rejects.toBeInstanceOf(CheckoutUnavailableError);

    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.repository.replaceStripeCustomer).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });

  it('repairs an unsafe stored URL through the existing idempotent Session request', async () => {
    const setup = harness('javascript:alert(document.domain)');

    await expect(setup.provider.createCheckout(user)).resolves.toEqual({
      url: 'https://checkout.stripe.test/session',
    });
    expect(setup.sessionsCreate).toHaveBeenCalledOnce();
    expect(setup.sessionsCreate).toHaveBeenCalledWith(expect.anything(), {
      idempotencyKey: `foodscope-checkout-${setup.attempt.id}`,
    });
    expect(setup.repository.completeCheckoutAttempt).toHaveBeenCalledWith(
      user.id,
      setup.attempt.id,
      expect.objectContaining({ url: 'https://checkout.stripe.test/session' }),
    );
  });

  it('replaces a stale unsaved attempt after Stripe definitively rejects its expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:02:00.000Z'));
    const setup = harness(null, 'cus_existing');
    const replacement = {
      id: '00000000-0000-4000-8000-000000000100',
      expiresAt: new Date('2030-01-01T01:02:00.000Z'),
      sessionUrl: null,
      priceId: 'price_test',
      customerId: 'cus_existing',
    };
    vi.mocked(setup.repository.getOrCreateCheckoutAttempt)
      .mockResolvedValueOnce(setup.attempt)
      .mockResolvedValueOnce(replacement);
    setup.sessionsCreate
      .mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        message: 'synthetic expiry rejection',
        param: 'expires_at',
      }))
      .mockResolvedValueOnce({
        ...setup.session,
        id: 'cs_recovered',
        url: 'https://checkout.stripe.test/recovered',
        expires_at: Math.floor(replacement.expiresAt.getTime() / 1000),
      });

    try {
      await expect(setup.provider.createCheckout({
        ...user,
        stripeCustomerId: 'cus_existing',
      })).resolves.toEqual({ url: 'https://checkout.stripe.test/recovered' });

      expect(setup.repository.releaseCheckoutAttempt).toHaveBeenCalledWith(
        user.id,
        setup.attempt.id,
      );
      expect(setup.sessionsCreate).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        { idempotencyKey: `foodscope-checkout-${setup.attempt.id}` },
      );
      expect(setup.sessionsCreate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          expires_at: Math.floor(replacement.expiresAt.getTime() / 1000),
        }),
        { idempotencyKey: `foodscope-checkout-${replacement.id}` },
      );
      expect(setup.subscriptionsList).toHaveBeenCalledTimes(2);
      expect(setup.customersCreate).not.toHaveBeenCalled();
      expect(setup.repository.completeCheckoutAttempt).toHaveBeenCalledWith(
        user.id,
        replacement.id,
        expect.objectContaining({ id: 'cs_recovered' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds stale-expiry recovery to one replacement attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:02:00.000Z'));
    const setup = harness(null, 'cus_existing');
    const replacement = {
      id: '00000000-0000-4000-8000-000000000100',
      expiresAt: new Date('2030-01-01T01:02:00.000Z'),
      sessionUrl: null,
      priceId: 'price_test',
      customerId: 'cus_existing',
    };
    vi.mocked(setup.repository.getOrCreateCheckoutAttempt)
      .mockResolvedValueOnce(setup.attempt)
      .mockResolvedValueOnce(replacement);
    const expiryError = new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      message: 'synthetic expiry rejection',
      param: 'expires_at',
    });
    setup.sessionsCreate.mockRejectedValue(expiryError);

    try {
      await expect(setup.provider.createCheckout({
        ...user,
        stripeCustomerId: 'cus_existing',
      })).rejects.toBe(expiryError);

      expect(setup.sessionsCreate).toHaveBeenCalledTimes(2);
      expect(setup.repository.releaseCheckoutAttempt).toHaveBeenCalledOnce();
      expect(setup.repository.releaseCheckoutAttempt).toHaveBeenCalledWith(
        user.id,
        setup.attempt.id,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replace an attempt for a different invalid Stripe parameter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:02:00.000Z'));
    const setup = harness(null, 'cus_existing');
    const priceError = new Stripe.errors.StripeInvalidRequestError({
      type: 'invalid_request_error',
      message: 'synthetic Price rejection',
      param: 'line_items[0][price]',
    });
    setup.sessionsCreate.mockRejectedValueOnce(priceError);

    try {
      await expect(setup.provider.createCheckout({
        ...user,
        stripeCustomerId: 'cus_existing',
      })).rejects.toBe(priceError);

      expect(setup.sessionsCreate).toHaveBeenCalledOnce();
      expect(setup.repository.releaseCheckoutAttempt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not persist or return an unsafe URL from Stripe', async () => {
    const setup = harness();
    setup.sessionsCreate.mockResolvedValueOnce({
      ...setup.session,
      id: 'cs_unsafe',
      url: 'http://checkout.stripe.test/session',
    });

    await expect(setup.provider.createCheckout(user)).rejects.toThrow('safe Checkout URL');
    expect(setup.repository.completeCheckoutAttempt).not.toHaveBeenCalled();
  });

  it.each([
    { object: 'invoice' },
    { id: '' },
    { id: 'c'.repeat(256) },
    { livemode: true },
    { mode: 'payment' },
    { status: 'expired' },
    { customer: 'cus_other' },
    { customer: { id: 'cus_test', object: 'invoice' } },
    { customer: { id: 'cus_test', object: 'customer', deleted: true } },
    { customer: { id: 'cus_test', object: 'customer', deleted: false, livemode: true } },
    { metadata: { demoUserId: 'unexpected-user' } },
    { expires_at: Number.NaN },
    { expires_at: Math.floor(new Date('2030-01-01T00:30:00Z').getTime() / 1000) },
  ])('does not persist a contract-invalid Checkout Session %#', async (override) => {
    const setup = harness();
    setup.sessionsCreate.mockResolvedValueOnce({ ...setup.session, ...override });

    await expect(setup.provider.createCheckout(user)).rejects.toThrow(
      'valid Checkout Session',
    );
    expect(setup.repository.completeCheckoutAttempt).not.toHaveBeenCalled();
    expect(setup.repository.releaseCheckoutAttempt).not.toHaveBeenCalled();
  });

  it.each(['active', 'unpaid'] as const)(
    'does not create another Session when the Customer has an %s subscription',
    async (status) => {
      const setup = harness(null, 'cus_existing');
      setup.subscriptionsList.mockResolvedValueOnce({
        data: [{
          id: 'sub_existing', object: 'subscription', livemode: false,
          customer: 'cus_existing', status,
        }],
        has_more: false,
      });

      await expect(setup.provider.createCheckout({
        ...user,
        stripeCustomerId: 'cus_existing',
      })).rejects.toBeInstanceOf(CheckoutUnavailableError);
      expect(setup.subscriptionsList).toHaveBeenCalledWith({
        customer: 'cus_existing',
        status: 'all',
        limit: 100,
      });
      expect(setup.sessionsCreate).not.toHaveBeenCalled();
      expect(setup.repository.completeCheckoutAttempt).not.toHaveBeenCalled();
    },
  );

  it('allows recovery after only terminal subscriptions', async () => {
    const setup = harness(null, 'cus_existing');
    setup.subscriptionsList.mockResolvedValueOnce({
      data: [
        {
          id: 'sub_canceled', object: 'subscription', livemode: false,
          customer: 'cus_existing', status: 'canceled',
        },
        {
          id: 'sub_expired', object: 'subscription', livemode: false,
          customer: 'cus_existing', status: 'incomplete_expired',
        },
      ],
      has_more: false,
    });

    await expect(setup.provider.createCheckout({
      ...user,
      stripeCustomerId: 'cus_existing',
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).toHaveBeenCalledOnce();
  });

  it.each([
    ['omits pagination completeness', { data: [] }],
    ['reports another page', { data: [], has_more: true }],
    ['omits subscription data', { has_more: false }],
    ['returns malformed subscription data', { data: [null], has_more: false }],
    ['returns a non-Subscription terminal object', {
      data: [{
        id: 'sub_wrong_object', object: 'invoice', livemode: false,
        customer: 'cus_existing', status: 'canceled',
      }],
      has_more: false,
    }],
    ['returns a terminal Subscription for another Customer', {
      data: [{
        id: 'sub_wrong_customer', object: 'subscription', livemode: false,
        customer: 'cus_other', status: 'canceled',
      }],
      has_more: false,
    }],
    ['returns a terminal Subscription with a non-Customer expanded reference', {
      data: [{
        id: 'sub_wrong_customer_object', object: 'subscription', livemode: false,
        customer: { id: 'cus_existing', object: 'invoice' }, status: 'canceled',
      }],
      has_more: false,
    }],
    ['returns a terminal Subscription with a deleted expanded Customer', {
      data: [{
        id: 'sub_deleted_customer', object: 'subscription', livemode: false,
        customer: { id: 'cus_existing', object: 'customer', deleted: true }, status: 'canceled',
      }],
      has_more: false,
    }],
    ['returns a terminal Subscription with a live-mode expanded Customer', {
      data: [{
        id: 'sub_live_customer', object: 'subscription', livemode: false,
        customer: {
          id: 'cus_existing', object: 'customer', deleted: false, livemode: true,
        },
        status: 'canceled',
      }],
      has_more: false,
    }],
    ['returns a live-mode terminal Subscription', {
      data: [{
        id: 'sub_live', object: 'subscription', livemode: true,
        customer: 'cus_existing', status: 'canceled',
      }],
      has_more: false,
    }],
  ])('does not create a Session when Stripe %s', async (_case, response) => {
    const setup = harness(null, 'cus_existing');
    setup.subscriptionsList.mockResolvedValueOnce(response);

    await expect(setup.provider.createCheckout({
      ...user,
      stripeCustomerId: 'cus_existing',
    })).rejects.toBeInstanceOf(CheckoutUnavailableError);

    expect(setup.sessionsCreate).not.toHaveBeenCalled();
    expect(setup.repository.completeCheckoutAttempt).not.toHaveBeenCalled();
  });

  it('replaces a deleted stored Customer before creating Checkout', async () => {
    const setup = harness(null, 'cus_deleted');
    const replacementAttempt = {
      ...setup.attempt,
      id: '00000000-0000-4000-8000-000000000102',
      customerId: 'cus_test',
    };
    vi.mocked(setup.repository.getOrCreateCheckoutAttempt)
      .mockResolvedValueOnce(setup.attempt)
      .mockResolvedValueOnce(replacementAttempt);
    setup.customersRetrieve.mockResolvedValueOnce({
      id: 'cus_deleted', object: 'customer', deleted: true,
    });

    await expect(setup.provider.createCheckout({
      ...user,
      stripeCustomerId: 'cus_deleted',
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/session' });

    expect(setup.customersRetrieve).toHaveBeenCalledWith('cus_deleted');
    expect(setup.customersCreate).toHaveBeenCalledWith(expect.anything(), {
      idempotencyKey: expect.stringMatching(/^foodscope-demo-customer-replacement-[a-f0-9]{64}$/),
    });
    expect(setup.repository.replaceStripeCustomer).toHaveBeenCalledWith(
      user.id,
      'cus_deleted',
      setup.attempt.id,
      'cus_test',
    );
    expect(setup.subscriptionsList).toHaveBeenCalledWith({
      customer: 'cus_test',
      status: 'all',
      limit: 100,
    });
    expect(setup.sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_test' }),
      expect.anything(),
    );
  });

  it('does not replace a deleted Customer with misattributed provider output', async () => {
    const setup = harness(null, 'cus_deleted');
    setup.customersRetrieve.mockResolvedValueOnce({
      id: 'cus_deleted', object: 'customer', deleted: true,
    });
    setup.customersCreate.mockResolvedValueOnce({
      id: 'cus_wrong_owner',
      object: 'customer',
      livemode: false,
      metadata: { demoUserId: 'unexpected-user' },
    });

    await expect(setup.provider.createCheckout({
      ...user,
      stripeCustomerId: 'cus_deleted',
    })).rejects.toThrow('valid Stripe Customer');

    expect(setup.repository.replaceStripeCustomer).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });

  it('does not create resources when the stored Customer read fails', async () => {
    const setup = harness(null, 'cus_existing');
    setup.customersRetrieve.mockRejectedValueOnce(new Error('temporary Customer read failure'));

    await expect(setup.provider.createCheckout({
      ...user,
      stripeCustomerId: 'cus_existing',
    })).rejects.toThrow('temporary Customer read failure');

    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.subscriptionsList).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
    expect(setup.repository.replaceStripeCustomer).not.toHaveBeenCalled();
  });

  it('retries a deleted-Customer replacement without duplicating the Customer', async () => {
    const setup = harness(null, 'cus_deleted');
    const replacementAttempt = {
      ...setup.attempt,
      id: '00000000-0000-4000-8000-000000000103',
      customerId: 'cus_test',
    };
    vi.mocked(setup.repository.getOrCreateCheckoutAttempt)
      .mockResolvedValueOnce(setup.attempt)
      .mockResolvedValueOnce(setup.attempt)
      .mockResolvedValueOnce(replacementAttempt);
    setup.customersRetrieve.mockImplementation(async (id) =>
      id === 'cus_deleted'
        ? { id, object: 'customer', deleted: true }
        : {
          id, object: 'customer', deleted: false, livemode: false,
          metadata: { demoUserId: user.id },
        });
    vi.mocked(setup.repository.replaceStripeCustomer)
      .mockRejectedValueOnce(new Error('temporary database failure'))
      .mockResolvedValueOnce('cus_test');
    const checkoutUser = { ...user, stripeCustomerId: 'cus_deleted' };

    await expect(setup.provider.createCheckout(checkoutUser)).rejects.toThrow(
      'temporary database failure',
    );
    expect(setup.sessionsCreate).not.toHaveBeenCalled();

    await expect(setup.provider.createCheckout(checkoutUser)).resolves.toEqual({
      url: 'https://checkout.stripe.test/session',
    });
    expect(setup.customersCreate).toHaveBeenCalledTimes(2);
    const idempotencyKeys = setup.customersCreate.mock.calls.map((call) => call[1]?.idempotencyKey);
    expect(idempotencyKeys[0]).toEqual(idempotencyKeys[1]);
    expect(setup.repository.replaceStripeCustomer).toHaveBeenCalledTimes(2);
    expect(setup.sessionsCreate).toHaveBeenCalledOnce();
  });
});
