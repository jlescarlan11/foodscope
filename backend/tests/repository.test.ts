import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { createRepository } from '../src/repository.js';
import { DEMO_USER_ID } from '../src/constants.js';
import { CheckoutUnavailableError } from '../src/errors.js';
import { prisma } from '../src/prisma.js';

function subscription(status: Stripe.Subscription.Status) {
  return {
    id: 'sub_current',
    object: 'subscription',
    livemode: false,
    customer: 'cus_demo',
    metadata: { demoUserId: DEMO_USER_ID },
    status,
    items: { data: [{
      object: 'subscription_item',
      current_period_end: 1_800_000_000,
      price: {
        id: 'price_test', object: 'price', livemode: false, type: 'recurring',
        recurring: { interval: 'month', interval_count: 1 },
      },
    }] },
  } as unknown as Stripe.Subscription;
}

function subscriptionEvent(id = 'evt_stale') {
  return {
    id,
    type: 'customer.subscription.updated',
    data: { object: subscription('active') },
  } as Stripe.Event;
}

const eventMarker = () => ({
  createMany: vi.fn(async () => ({ count: 1 })),
});

const createBillingRepository = (database: typeof prisma) =>
  createRepository(database, 'price_test');

describe('Stripe webhook repository', () => {
  it('selects only workflow-required demo-user columns', async () => {
    const findUnique = vi.fn(async () => null);
    const database = { user: { findUnique } } as unknown as typeof prisma;
    const subject = createRepository(database);

    await subject.getDemoUser();
    await subject.getDemoUserForCheckout();

    expect(findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: DEMO_USER_ID },
      select: { id: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true },
    });
    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: DEMO_USER_ID },
      select: {
        id: true,
        email: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        stripeCheckoutAttemptId: true,
        stripeCheckoutSessionId: true,
        stripeCheckoutSessionUrl: true,
        stripeCheckoutExpiresAt: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodEnd: true,
      },
    });
  });

  it('reserves a stable one-hour Checkout window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const database = {
      user: {
        findUniqueOrThrow: vi.fn(async () => ({
          subscriptionStatus: 'inactive',
          stripeCheckoutAttemptId: null,
          stripeCheckoutSessionUrl: null,
          stripeCheckoutExpiresAt: null,
        })),
        updateMany,
      },
    } as unknown as typeof prisma;

    try {
      const attempt = await createRepository(database).getOrCreateCheckoutAttempt(DEMO_USER_ID);

      expect(attempt.expiresAt).toEqual(new Date('2030-01-01T01:00:00.000Z'));
      expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ stripeCheckoutExpiresAt: attempt.expiresAt }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases only the matching Checkout attempt before a Session is stored', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const database = { user: { updateMany } } as unknown as typeof prisma;

    await createRepository(database).releaseCheckoutAttempt(DEMO_USER_ID, 'attempt_stale');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: DEMO_USER_ID,
        stripeCheckoutAttemptId: 'attempt_stale',
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionUrl: null,
      },
      data: {
        stripeCheckoutAttemptId: null,
        stripeCheckoutPriceId: null,
        stripeCheckoutExpiresAt: null,
      },
    });
  });

  it('replaces only the expected stored Stripe Customer', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const database = { user: { updateMany } } as unknown as typeof prisma;

    await expect(createRepository(database).replaceStripeCustomer(
      DEMO_USER_ID,
      'cus_deleted',
      'attempt_deleted',
      'cus_replacement',
    )).resolves.toBe('cus_replacement');

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: DEMO_USER_ID,
        stripeCustomerId: 'cus_deleted',
        stripeCheckoutAttemptId: 'attempt_deleted',
      },
      data: {
        stripeCustomerId: 'cus_replacement',
        stripeCheckoutAttemptId: null,
        stripeCheckoutPriceId: null,
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionUrl: null,
        stripeCheckoutExpiresAt: null,
      },
    });
  });

  it('reuses the same replacement Customer after a concurrent compare-and-set loss', async () => {
    const database = {
      user: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findUnique: vi.fn(async () => ({ stripeCustomerId: 'cus_replacement' })),
      },
    } as unknown as typeof prisma;

    await expect(createRepository(database).replaceStripeCustomer(
      DEMO_USER_ID,
      'cus_deleted',
      'attempt_deleted',
      'cus_replacement',
    )).resolves.toBe('cus_replacement');
  });

  it('does not overwrite a different concurrently replaced Stripe Customer', async () => {
    const database = {
      user: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findUnique: vi.fn(async () => ({ stripeCustomerId: 'cus_other' })),
      },
    } as unknown as typeof prisma;

    await expect(createRepository(database).replaceStripeCustomer(
      DEMO_USER_ID,
      'cus_deleted',
      'attempt_deleted',
      'cus_replacement',
    )).rejects.toBeInstanceOf(CheckoutUnavailableError);
  });

  it('does not clear a newer Checkout attempt while replacing a deleted Customer', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const database = {
      user: {
        updateMany,
        findUnique: vi.fn(async () => ({ stripeCustomerId: 'cus_deleted' })),
      },
    } as unknown as typeof prisma;

    await expect(createRepository(database).replaceStripeCustomer(
      DEMO_USER_ID,
      'cus_deleted',
      'attempt_stale',
      'cus_replacement',
    )).rejects.toBeInstanceOf(CheckoutUnavailableError);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ stripeCheckoutAttemptId: 'attempt_stale' }),
    }));
  });

  it.each([null, 'price_previous'])(
    'blocks a future Checkout attempt without the configured Price binding (%s)',
    async (stripeCheckoutPriceId) => {
      const updateMany = vi.fn();
      const database = {
        user: {
          findUniqueOrThrow: vi.fn(async () => ({
            subscriptionStatus: 'inactive',
            stripeCheckoutAttemptId: 'attempt_previous',
            stripeCheckoutPriceId,
            stripeCheckoutSessionUrl: 'https://checkout.stripe.test/previous',
            stripeCheckoutExpiresAt: new Date('2100-01-01T00:00:00.000Z'),
          })),
          updateMany,
        },
      } as unknown as typeof prisma;

      await expect(createRepository(database, 'price_test').getOrCreateCheckoutAttempt(DEMO_USER_ID))
        .rejects.toBeInstanceOf(CheckoutUnavailableError);
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it('uses the Checkout eligibility allowlist in the atomic attempt reservation', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const database = {
      user: {
        findUniqueOrThrow: vi.fn()
          .mockResolvedValueOnce({
            subscriptionStatus: 'inactive',
            stripeCheckoutAttemptId: null,
            stripeCheckoutSessionUrl: null,
            stripeCheckoutExpiresAt: null,
          })
          .mockResolvedValueOnce({
            subscriptionStatus: 'past_due',
            stripeCheckoutAttemptId: null,
            stripeCheckoutSessionUrl: null,
            stripeCheckoutExpiresAt: null,
          }),
        updateMany,
      },
    } as unknown as typeof prisma;

    await expect(createRepository(database).getOrCreateCheckoutAttempt(DEMO_USER_ID))
      .rejects.toBeInstanceOf(CheckoutUnavailableError);

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        subscriptionStatus: { in: ['inactive', 'canceled', 'incomplete_expired'] },
      }),
    }));
  });

  it('stores the freshly retrieved subscription instead of the delivered stale snapshot', async () => {
    const operations: string[] = [];
    const update = vi.fn(async () => { operations.push('update'); });
    const tx = {
      stripeWebhookEvent: {
        createMany: vi.fn(async () => { operations.push('event'); return { count: 1 }; }),
      },
      $queryRaw: vi.fn(async () => { operations.push('lock'); return [{ id: DEMO_USER_ID }]; }),
      user: { update, findUnique: vi.fn(async () => ({
        id: DEMO_USER_ID,
        stripeCustomerId: 'cus_demo',
        stripeSubscriptionId: 'sub_current',
        stripeCheckoutAttemptId: null,
      })) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      stripeWebhookEvent: { findUnique: vi.fn() },
    } as unknown as typeof prisma;

    const current = subscription('canceled');
    current.customer = {
      id: 'cus_demo', object: 'customer', deleted: false, livemode: false,
    } as unknown as Stripe.Customer;
    current.metadata.demoUserId = 'unexpected-user';
    await createBillingRepository(database).processStripeEvent(subscriptionEvent(), async () => current);

    expect(operations).toEqual(['event', 'lock', 'update']);
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 15_000,
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: DEMO_USER_ID },
      data: expect.objectContaining({
        stripeSubscriptionId: 'sub_current',
        subscriptionStatus: 'canceled',
      }),
    }));
    expect(tx.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: DEMO_USER_ID },
    }));
  });

  it.each([
    ['non-Subscription object', { object: 'invoice', livemode: false }],
    ['live-mode Subscription', { object: 'subscription', livemode: true }],
    ['Subscription with a deleted expanded Customer', {
      customer: { id: 'cus_demo', object: 'customer', deleted: true },
    }],
    ['Subscription with a live-mode expanded Customer', {
      customer: { id: 'cus_demo', object: 'customer', deleted: false, livemode: true },
    }],
  ])('rolls back instead of granting from a retrieved %s', async (_description, shape) => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: { update, findUnique: vi.fn(async () => ({
        id: DEMO_USER_ID,
        stripeCustomerId: 'cus_demo',
        stripeSubscriptionId: 'sub_current',
        stripeCheckoutAttemptId: null,
      })) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const current = { ...subscription('active'), ...shape } as unknown as Stripe.Subscription;

    await expect(createBillingRepository(database).processStripeEvent(
      subscriptionEvent('evt_invalid_current_subscription'),
      async () => current,
    )).rejects.toThrow('Current Stripe subscription is required');

    expect(update).not.toHaveBeenCalled();
  });

  it('fails closed when the active subscription no longer contains the monthly plan', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: { update, findUnique: vi.fn(async () => ({
        id: DEMO_USER_ID,
        stripeCustomerId: 'cus_demo',
        stripeSubscriptionId: 'sub_current',
        stripeCheckoutAttemptId: null,
      })) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const current = subscription('active') as unknown as Record<string, unknown>;
    current.items = { data: [{
      object: 'subscription_item',
      current_period_end: 1_800_000_000,
      price: {
        id: 'price_other', object: 'price', livemode: false, type: 'recurring',
        recurring: { interval: 'year', interval_count: 1 },
      },
    }] };

    await createBillingRepository(database).processStripeEvent(
      subscriptionEvent('evt_wrong_price'),
      async () => current as unknown as Stripe.Subscription,
    );

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        subscriptionStatus: 'unknown',
        subscriptionCurrentPeriodEnd: null,
      }),
    }));
  });

  it.each([
    ['configured monthly item is not a Stripe Price object', 'subscription_item', 'product'],
    ['configured Price belongs to a non-Subscription item', 'invoiceitem', 'price'],
  ])('fails closed when the %s', async (_description, itemObject, priceObject) => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: { update, findUnique: vi.fn(async () => ({
        id: DEMO_USER_ID,
        stripeCustomerId: 'cus_demo',
        stripeSubscriptionId: 'sub_current',
        stripeCheckoutAttemptId: null,
      })) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const current = subscription('active') as unknown as Record<string, unknown>;
    current.items = { data: [{
      object: itemObject,
      current_period_end: 1_800_000_000,
      price: {
        id: 'price_test', object: priceObject, livemode: false, type: 'recurring',
        recurring: { interval: 'month', interval_count: 1 },
      },
    }] };

    await createBillingRepository(database).processStripeEvent(
      subscriptionEvent(`evt_invalid_item_${itemObject}`),
      async () => current as unknown as Stripe.Subscription,
    );

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        subscriptionStatus: 'unknown',
        subscriptionCurrentPeriodEnd: null,
      }),
    }));
  });

  it('uses only the configured monthly item to determine entitlement expiry', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: { update, findUnique: vi.fn(async () => ({
        id: DEMO_USER_ID,
        stripeCustomerId: 'cus_demo',
        stripeSubscriptionId: 'sub_current',
        stripeCheckoutAttemptId: null,
      })) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const current = subscription('active') as unknown as Record<string, unknown>;
    current.items = { data: [
      {
        object: 'subscription_item',
        current_period_end: 1_800_000_000,
        price: {
          id: 'price_test', object: 'price', livemode: false, type: 'recurring',
          recurring: { interval: 'month', interval_count: 1 },
        },
      },
      {
        object: 'subscription_item',
        current_period_end: 1_900_000_000,
        price: {
          id: 'price_other', object: 'price', livemode: false, type: 'recurring',
          recurring: { interval: 'year', interval_count: 1 },
        },
      },
    ] };

    await createBillingRepository(database).processStripeEvent(
      subscriptionEvent('evt_multiple_prices'),
      async () => current as unknown as Stripe.Subscription,
    );

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        subscriptionStatus: 'active',
        subscriptionCurrentPeriodEnd: new Date(1_800_000_000 * 1000),
      }),
    }));
  });

  it('fails closed when the configured plan appears more than once', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: { update, findUnique: vi.fn(async () => ({
        id: DEMO_USER_ID,
        stripeCustomerId: 'cus_demo',
        stripeSubscriptionId: 'sub_current',
        stripeCheckoutAttemptId: null,
      })) },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const current = subscription('active') as unknown as Record<string, unknown>;
    current.items = { data: [1_800_000_000, 1_900_000_000].map((currentPeriodEnd) => ({
      object: 'subscription_item',
      current_period_end: currentPeriodEnd,
      price: {
        id: 'price_test', object: 'price', livemode: false, type: 'recurring',
        recurring: { interval: 'month', interval_count: 1 },
      },
    })) };

    await createBillingRepository(database).processStripeEvent(
      subscriptionEvent('evt_duplicate_plan_items'),
      async () => current as unknown as Stripe.Subscription,
    );

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        subscriptionStatus: 'unknown',
        subscriptionCurrentPeriodEnd: null,
      }),
    }));
  });

  it('ignores a different subscription even when it carries demo-user metadata', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: {
        update,
        findUnique: vi.fn(async () => ({
          id: DEMO_USER_ID,
          stripeCustomerId: 'cus_demo',
          stripeSubscriptionId: 'sub_authoritative',
          stripeCheckoutAttemptId: null,
        })),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      stripeWebhookEvent: { findUnique: vi.fn() },
    } as unknown as typeof prisma;

    await createBillingRepository(database).processStripeEvent(
      subscriptionEvent(),
      async () => subscription('active'),
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('does not adopt an unproven subscription when no subscription is stored', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: {
        update,
        findUnique: vi.fn(async () => ({
          id: DEMO_USER_ID,
          stripeCustomerId: 'cus_demo',
          stripeSubscriptionId: null,
          stripeCheckoutAttemptId: null,
        })),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      stripeWebhookEvent: { findUnique: vi.fn() },
    } as unknown as typeof prisma;

    await createBillingRepository(database).processStripeEvent(
      subscriptionEvent('evt_unproven_subscription'),
      async () => subscription('active'),
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a new subscription only when it matches the durable Checkout attempt', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: {
        update,
        findUnique: vi.fn(async () => ({
          id: DEMO_USER_ID,
          stripeCustomerId: 'cus_demo',
          stripeSubscriptionId: 'sub_previous',
          stripeCheckoutAttemptId: 'attempt_current',
        })),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      stripeWebhookEvent: { findUnique: vi.fn() },
    } as unknown as typeof prisma;
    const current = subscription('active');
    current.metadata.checkoutAttemptId = 'attempt_current';

    await createBillingRepository(database).processStripeEvent(subscriptionEvent(), async () => current);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: DEMO_USER_ID },
      data: expect.objectContaining({
        stripeSubscriptionId: 'sub_current',
        subscriptionStatus: 'active',
        stripeCheckoutAttemptId: null,
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionUrl: null,
        stripeCheckoutExpiresAt: null,
      }),
    }));
  });

  it('does not adopt a Checkout handoff carrying a different demo-user owner', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: {
        update,
        findUnique: vi.fn(async () => ({
          id: DEMO_USER_ID,
          stripeCustomerId: 'cus_demo',
          stripeSubscriptionId: 'sub_previous',
          stripeCheckoutAttemptId: 'attempt_current',
        })),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const current = subscription('active');
    current.metadata.checkoutAttemptId = 'attempt_current';
    current.metadata.demoUserId = 'unexpected-user';

    await createBillingRepository(database).processStripeEvent(
      subscriptionEvent('evt_wrong_checkout_owner'),
      async () => current,
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('preserves a new Checkout attempt when an old terminal subscription event arrives', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: {
        update,
        findUnique: vi.fn(async () => ({
          id: DEMO_USER_ID,
          stripeCustomerId: 'cus_demo',
          stripeSubscriptionId: 'sub_current',
          stripeCheckoutAttemptId: 'attempt_recovery',
        })),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      stripeWebhookEvent: { findUnique: vi.fn() },
    } as unknown as typeof prisma;

    await createBillingRepository(database).processStripeEvent(
      subscriptionEvent('evt_old_terminal'),
      async () => subscription('canceled'),
    );

    const data = update.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).toMatchObject({ stripeSubscriptionId: 'sub_current', subscriptionStatus: 'canceled' });
    expect(data).not.toHaveProperty('stripeCheckoutAttemptId');
    expect(data).not.toHaveProperty('stripeCheckoutSessionId');
    expect(data).not.toHaveProperty('stripeCheckoutSessionUrl');
    expect(data).not.toHaveProperty('stripeCheckoutExpiresAt');
  });

  it.each([undefined, 'future_status_that_does_not_fit_the_database_column_without_normalizing'])(
    'stores unsupported Stripe status %p as unknown and fails closed',
    async (status) => {
      const update = vi.fn();
      const tx = {
        stripeWebhookEvent: eventMarker(),
        $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
        user: {
          update,
          findUnique: vi.fn(async () => ({
            id: DEMO_USER_ID,
            stripeCustomerId: 'cus_demo',
            stripeSubscriptionId: 'sub_current',
            stripeCheckoutAttemptId: null,
          })),
        },
      };
      const database = {
        $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
        stripeWebhookEvent: { findUnique: vi.fn() },
      } as unknown as typeof prisma;
      const current = subscription('active') as unknown as Record<string, unknown>;
      current.status = status;

      await createBillingRepository(database).processStripeEvent(
        subscriptionEvent('evt_unknown_status'),
        async () => current as unknown as Stripe.Subscription,
      );

      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ subscriptionStatus: 'unknown' }),
      }));
    },
  );

  it.each([
    undefined,
    { data: [] },
    { data: [{ current_period_end: Number.POSITIVE_INFINITY }] },
    { data: [{
      object: 'subscription_item',
      current_period_end: 253_402_300_800,
      price: {
        id: 'price_test', object: 'price', livemode: false, type: 'recurring',
        recurring: { interval: 'month', interval_count: 1 },
      },
    }] },
  ])('fails closed when an active subscription has malformed items %p', async (items) => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: {
        update,
        findUnique: vi.fn(async () => ({
          id: DEMO_USER_ID,
          stripeCustomerId: 'cus_demo',
          stripeSubscriptionId: 'sub_current',
          stripeCheckoutAttemptId: null,
        })),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      stripeWebhookEvent: { findUnique: vi.fn() },
    } as unknown as typeof prisma;
    const current = subscription('active') as unknown as Record<string, unknown>;
    current.items = items;

    await createBillingRepository(database).processStripeEvent(
      subscriptionEvent('evt_malformed_period'),
      async () => current as unknown as Stripe.Subscription,
    );

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        subscriptionStatus: 'unknown',
        subscriptionCurrentPeriodEnd: null,
      }),
    }));
  });

  it('does not call Stripe for a subscription event that cannot map to the demo user', async () => {
    const retrieveSubscription = vi.fn(async () => subscription('active'));
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => []),
      user: { update: vi.fn(), findUnique: vi.fn() },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      stripeWebhookEvent: { findUnique: vi.fn() },
    } as unknown as typeof prisma;

    const delivered = subscriptionEvent();
    (delivered.data.object as Stripe.Subscription).metadata.demoUserId = 'unexpected-user';
    await createBillingRepository(database).processStripeEvent(delivered, retrieveSubscription);

    expect(retrieveSubscription).not.toHaveBeenCalled();
    const lockQuery = (tx.$queryRaw.mock.calls as unknown[][])[0]?.[0] as {
      values: unknown[];
    };
    expect(lockQuery.values).toEqual([DEMO_USER_ID, 'sub_current', 'cus_demo']);
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('retrieves current state when delivered Subscription metadata is malformed', async () => {
    const update = vi.fn();
    const retrieveSubscription = vi.fn(async () => subscription('canceled'));
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: {
        update,
        findUnique: vi.fn(async () => ({
          id: DEMO_USER_ID,
          stripeCustomerId: 'cus_demo',
          stripeSubscriptionId: 'sub_current',
          stripeCheckoutAttemptId: null,
        })),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const delivered = subscriptionEvent('evt_malformed_delivered_metadata');
    (delivered.data.object as unknown as Record<string, unknown>).metadata = null;

    await createBillingRepository(database).processStripeEvent(delivered, retrieveSubscription);

    expect(retrieveSubscription).toHaveBeenCalledWith('sub_current');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        subscriptionStatus: 'canceled',
        subscriptionCurrentPeriodEnd: new Date(1_800_000_000 * 1000),
      }),
    }));
  });

  it('retrieves a stored Subscription when its delivered Customer is malformed', async () => {
    const update = vi.fn();
    const retrieveSubscription = vi.fn(async () => subscription('canceled'));
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(async () => [{ id: DEMO_USER_ID }]),
      user: {
        update,
        findUnique: vi.fn(async () => ({
          id: DEMO_USER_ID,
          stripeCustomerId: 'cus_demo',
          stripeSubscriptionId: 'sub_current',
          stripeCheckoutAttemptId: null,
        })),
      },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const delivered = subscriptionEvent('evt_malformed_delivered_customer');
    (delivered.data.object as unknown as Record<string, unknown>).customer = null;

    await createBillingRepository(database).processStripeEvent(delivered, retrieveSubscription);

    expect(retrieveSubscription).toHaveBeenCalledWith('sub_current');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subscriptionStatus: 'canceled' }),
    }));
  });

  it('durably revokes entitlement for the mapped deleted Customer', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      stripeWebhookEvent: eventMarker(),
      user: { updateMany },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const deleted = {
      id: 'evt_customer_deleted',
      type: 'customer.deleted',
      data: { object: { id: 'cus_demo', object: 'customer', deleted: true } },
    } as unknown as Stripe.Event;

    await createBillingRepository(database).processStripeEvent(deleted);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: DEMO_USER_ID, stripeCustomerId: 'cus_demo' },
      data: {
        subscriptionStatus: 'canceled',
        subscriptionCurrentPeriodEnd: null,
      },
    });
  });

  it('does not revoke entitlement for a deleted event carrying a non-Customer object', async () => {
    const updateMany = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      user: { updateMany },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const malformed = {
      id: 'evt_customer_wrong_object',
      type: 'customer.deleted',
      data: { object: { id: 'cus_demo', object: 'subscription', deleted: true } },
    } as unknown as Stripe.Event;

    await createBillingRepository(database).processStripeEvent(malformed);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('clears only the matching expired Checkout Session', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      stripeWebhookEvent: eventMarker(),
      user: { updateMany },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const expired = {
      id: 'evt_checkout_expired',
      type: 'checkout.session.expired',
      data: { object: {
        id: 'cs_expired',
        object: 'checkout.session',
        customer: 'cus_demo',
        metadata: { demoUserId: DEMO_USER_ID },
        livemode: false,
        mode: 'subscription',
        status: 'expired',
      } },
    } as unknown as Stripe.Event;

    await createBillingRepository(database).processStripeEvent(expired);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: DEMO_USER_ID,
        stripeCustomerId: 'cus_demo',
        stripeCheckoutSessionId: 'cs_expired',
      },
      data: {
        stripeCheckoutAttemptId: null,
        stripeCheckoutPriceId: null,
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionUrl: null,
        stripeCheckoutExpiresAt: null,
      },
    });
  });

  it.each([
    ['non-Session object', { object: 'invoice', livemode: false, mode: 'subscription', status: 'expired' }],
    ['non-Customer expanded reference', {
      customer: { id: 'cus_demo', object: 'invoice' },
      livemode: false, mode: 'subscription', status: 'expired',
    }],
    ['deleted expanded Customer', {
      customer: { id: 'cus_demo', object: 'customer', deleted: true },
      livemode: false, mode: 'subscription', status: 'expired',
    }],
    ['live-mode Session', { livemode: true, mode: 'subscription', status: 'expired' }],
    ['non-subscription Session', { livemode: false, mode: 'payment', status: 'expired' }],
    ['unexpired Session', { livemode: false, mode: 'subscription', status: 'open' }],
  ])('keeps Checkout recovery for an expired event carrying a %s', async (_description, shape) => {
    const updateMany = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      user: { updateMany },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const expired = {
      id: 'evt_checkout_invalid_expiry',
      type: 'checkout.session.expired',
      data: { object: {
        id: 'cs_current',
        object: 'checkout.session',
        customer: 'cus_demo',
        metadata: { demoUserId: DEMO_USER_ID },
        ...shape,
      } },
    } as unknown as Stripe.Event;

    await createBillingRepository(database).processStripeEvent(expired);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('durably ignores completed Checkout with an oversized subscription ID', async () => {
    const updateMany = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      user: { updateMany },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const completed = {
      id: 'evt_checkout_oversized_subscription',
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_current',
        object: 'checkout.session',
        customer: 'cus_demo',
        subscription: 's'.repeat(256),
        metadata: { demoUserId: DEMO_USER_ID },
        livemode: false,
        mode: 'subscription',
        status: 'complete',
      } },
    } as unknown as Stripe.Event;

    await createBillingRepository(database).processStripeEvent(completed);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['non-Session object', { object: 'invoice', livemode: false, mode: 'subscription', status: 'complete' }],
    ['non-Customer expanded reference', {
      customer: { id: 'cus_demo', object: 'invoice' },
      livemode: false, mode: 'subscription', status: 'complete',
    }],
    ['deleted expanded Customer', {
      customer: { id: 'cus_demo', object: 'customer', deleted: true },
      livemode: false, mode: 'subscription', status: 'complete',
    }],
    ['non-Subscription expanded reference', {
      subscription: { id: 'sub_untrusted', object: 'invoice' },
      livemode: false, mode: 'subscription', status: 'complete',
    }],
    ['live-mode Session', { livemode: true, mode: 'subscription', status: 'complete' }],
    ['non-subscription Session', { livemode: false, mode: 'payment', status: 'complete' }],
    ['incomplete Session', { livemode: false, mode: 'subscription', status: 'open' }],
  ])('durably ignores a completed event carrying a %s', async (_description, shape) => {
    const updateMany = vi.fn();
    const tx = {
      stripeWebhookEvent: eventMarker(),
      user: { updateMany },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;
    const completed = {
      id: 'evt_checkout_invalid_shape',
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_current',
        object: 'checkout.session',
        customer: 'cus_demo',
        subscription: 'sub_untrusted',
        metadata: { demoUserId: DEMO_USER_ID },
        ...shape,
      } },
    } as unknown as Stripe.Event;

    await createBillingRepository(database).processStripeEvent(completed);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    'customer.subscription.updated',
    'checkout.session.completed',
    'checkout.session.expired',
    'customer.deleted',
  ] as const)('durably ignores a malformed %s event without Stripe or account work', async (type) => {
    const retrieveSubscription = vi.fn(async () => subscription('active'));
    const tx = {
      stripeWebhookEvent: eventMarker(),
      $queryRaw: vi.fn(),
      user: { update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      stripeWebhookEvent: { findUnique: vi.fn() },
    } as unknown as typeof prisma;
    const malformed = {
      id: 'evt_malformed',
      type,
      data: { object: null },
    } as unknown as Stripe.Event;

    await expect(createBillingRepository(database).processStripeEvent(malformed, retrieveSubscription))
      .resolves.toBeUndefined();

    expect(tx.stripeWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ id: 'evt_malformed', type }],
      skipDuplicates: true,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(retrieveSubscription).not.toHaveBeenCalled();
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('skips duplicate events atomically without Stripe work', async () => {
    const retrieveSubscription = vi.fn(async () => subscription('active'));
    const tx = {
      stripeWebhookEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
      $queryRaw: vi.fn(),
      user: { findUnique: vi.fn(), update: vi.fn() },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as typeof prisma;

    await expect(createBillingRepository(database).processStripeEvent(
      subscriptionEvent('evt_duplicate'),
      retrieveSubscription,
    )).resolves.toBeUndefined();
    expect(retrieveSubscription).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not hide transactional failures', async () => {
    const failure = new Error('transaction failed');
    const database = {
      $transaction: vi.fn(async () => { throw failure; }),
    } as unknown as typeof prisma;

    await expect(createBillingRepository(database).processStripeEvent(
      subscriptionEvent(),
      async () => subscription('active'),
    ))
      .rejects.toBe(failure);
  });
});
