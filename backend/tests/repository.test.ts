import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { createRepository } from '../src/repository.js';
import { DEMO_USER_ID } from '../src/constants.js';
import { CheckoutUnavailableError } from '../src/errors.js';
import { prisma } from '../src/prisma.js';

function subscription(status: Stripe.Subscription.Status) {
  return {
    id: 'sub_current',
    customer: 'cus_demo',
    metadata: { demoUserId: DEMO_USER_ID },
    status,
    items: { data: [{ current_period_end: 1_800_000_000 }] },
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
    current.metadata.demoUserId = 'unexpected-user';
    await createRepository(database).processStripeEvent(subscriptionEvent(), async () => current);

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

    await createRepository(database).processStripeEvent(
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

    await createRepository(database).processStripeEvent(
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

    await createRepository(database).processStripeEvent(subscriptionEvent(), async () => current);

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

    await createRepository(database).processStripeEvent(
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

      await createRepository(database).processStripeEvent(
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

    await createRepository(database).processStripeEvent(
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
    await createRepository(database).processStripeEvent(delivered, retrieveSubscription);

    expect(retrieveSubscription).not.toHaveBeenCalled();
    const lockQuery = (tx.$queryRaw.mock.calls as unknown[][])[0]?.[0] as {
      values: unknown[];
    };
    expect(lockQuery.values).toEqual([DEMO_USER_ID, 'cus_demo']);
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it.each([
    'customer.subscription.updated',
    'checkout.session.completed',
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

    await expect(createRepository(database).processStripeEvent(malformed, retrieveSubscription))
      .resolves.toBeUndefined();

    expect(tx.stripeWebhookEvent.createMany).toHaveBeenCalledWith({
      data: [{ id: 'evt_malformed', type }],
      skipDuplicates: true,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(retrieveSubscription).not.toHaveBeenCalled();
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
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

    await expect(createRepository(database).processStripeEvent(
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

    await expect(createRepository(database).processStripeEvent(
      subscriptionEvent(),
      async () => subscription('active'),
    ))
      .rejects.toBe(failure);
  });
});
