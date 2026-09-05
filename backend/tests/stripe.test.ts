import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { createBillingProvider, StripeBillingProvider } from '../src/stripe.js';
import { DEMO_USER_ID } from '../src/constants.js';
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
  } as unknown as Repository;
  const customersCreate = vi.fn(async () => ({ id: 'cus_test' }));
  const sessionsCreate = vi.fn(async () => ({
    id: 'cs_test',
    url: 'https://checkout.stripe.test/session',
    expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
  }));
  const stripe = {
    customers: { create: customersCreate },
    checkout: { sessions: { create: sessionsCreate } },
  } as unknown as Stripe;
  const provider = new StripeBillingProvider({
    port: 4000,
    frontendUrl: 'http://localhost:3000',
    openFoodFactsUserAgent: 'test',
    stripeSecretKey: 'sk_test_fake',
    stripePriceId: 'price_test',
  }, repository, stripe);
  return { provider, repository, customersCreate, sessionsCreate, attempt };
}

describe('Stripe Checkout creation', () => {
  it('disables billing only when every Stripe setting is absent', () => {
    expect(createBillingProvider({
      port: 4000,
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'test',
    }, {} as Repository)).toBeNull();
  });

  it('refuses partial Stripe configuration', () => {
    expect(() => createBillingProvider({
      port: 4000,
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'test',
      stripeSecretKey: 'sk_test_incomplete',
    }, {} as Repository)).toThrow('requires a test key, webhook secret, and Price ID');
  });

  it('refuses to initialize with a live-mode key', () => {
    expect(() => createBillingProvider({
      port: 4000,
      frontendUrl: 'http://localhost:3000',
      openFoodFactsUserAgent: 'test',
      stripeSecretKey: 'sk_live_forbidden',
      stripeWebhookSecret: 'whsec_fake',
      stripePriceId: 'price_fake',
    }, {} as Repository)).toThrow('only supports Stripe test mode');
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

  it('returns a stored open Session without creating any Stripe resource', async () => {
    const setup = harness('https://checkout.stripe.test/existing');

    await expect(setup.provider.createCheckout(user)).resolves.toEqual({
      url: 'https://checkout.stripe.test/existing',
    });
    expect(setup.customersCreate).not.toHaveBeenCalled();
    expect(setup.sessionsCreate).not.toHaveBeenCalled();
  });
});
