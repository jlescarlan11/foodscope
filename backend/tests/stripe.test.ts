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

function harness(sessionUrl: string | null = null) {
  const attempt = { id: '00000000-0000-4000-8000-000000000099', expiresAt: new Date('2030-01-01T00:31:00Z'), sessionUrl };
  const repository = {
    getOrCreateCheckoutAttempt: vi.fn(async () => attempt),
    setStripeCustomer: vi.fn(async () => undefined),
    completeCheckoutAttempt: vi.fn(async () => undefined),
    releaseCheckoutAttempt: vi.fn(async () => undefined),
  } as unknown as Repository;
  const customersCreate = vi.fn(async () => ({ id: 'cus_test' }));
  const sessionsCreate = vi.fn(async () => ({
    id: 'cs_test',
    url: 'https://checkout.stripe.test/session',
    expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
  }));
  const subscriptionsList = vi.fn(async (): Promise<{
    data: Array<{ status: Stripe.Subscription.Status }>;
    has_more: boolean;
  }> => ({ data: [], has_more: false }));
  const pricesRetrieve = vi.fn(async () => ({
    id: 'price_test',
    active: true,
    livemode: false,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1 },
  }));
  const stripe = {
    customers: { create: customersCreate },
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
    sessionsCreate,
    subscriptionsList,
    pricesRetrieve,
    attempt,
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

  it('returns a stored open Session without creating any Stripe resource', async () => {
    const setup = harness('https://checkout.stripe.test/existing');

    await expect(setup.provider.createCheckout(user)).resolves.toEqual({
      url: 'https://checkout.stripe.test/existing',
    });
    expect(setup.pricesRetrieve).toHaveBeenCalledOnce();
    expect(setup.customersCreate).not.toHaveBeenCalled();
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
    const setup = harness();
    const replacement = {
      id: '00000000-0000-4000-8000-000000000100',
      expiresAt: new Date('2030-01-01T01:02:00.000Z'),
      sessionUrl: null,
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
    const setup = harness();
    const replacement = {
      id: '00000000-0000-4000-8000-000000000100',
      expiresAt: new Date('2030-01-01T01:02:00.000Z'),
      sessionUrl: null,
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
    const setup = harness();
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
      id: 'cs_unsafe',
      url: 'http://checkout.stripe.test/session',
      expires_at: Math.floor(setup.attempt.expiresAt.getTime() / 1000),
    });

    await expect(setup.provider.createCheckout(user)).rejects.toThrow('safe Checkout URL');
    expect(setup.repository.completeCheckoutAttempt).not.toHaveBeenCalled();
  });

  it.each(['active', 'unpaid'] as const)(
    'does not create another Session when the Customer has an %s subscription',
    async (status) => {
      const setup = harness();
      setup.subscriptionsList.mockResolvedValueOnce({
        data: [{ status }],
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
    const setup = harness();
    setup.subscriptionsList.mockResolvedValueOnce({
      data: [{ status: 'canceled' }, { status: 'incomplete_expired' }],
      has_more: false,
    });

    await expect(setup.provider.createCheckout({
      ...user,
      stripeCustomerId: 'cus_existing',
    })).resolves.toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).toHaveBeenCalledOnce();
  });
});
