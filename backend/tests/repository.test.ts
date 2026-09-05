import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import { createRepository } from '../src/repository.js';
import { DEMO_USER_ID } from '../src/constants.js';
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

describe('Stripe webhook repository', () => {
  it('stores the freshly retrieved subscription instead of the delivered stale snapshot', async () => {
    const operations: string[] = [];
    const update = vi.fn(async () => { operations.push('update'); });
    const tx = {
      stripeWebhookEvent: { create: vi.fn(async () => { operations.push('event'); }) },
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

    await createRepository(database).processStripeEvent(
      subscriptionEvent(),
      async () => subscription('canceled'),
    );

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
  });

  it('ignores a different subscription even when it carries demo-user metadata', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: { create: vi.fn() },
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

  it('accepts a new subscription only when it matches the durable Checkout attempt', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: { create: vi.fn() },
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
      data: expect.objectContaining({ stripeSubscriptionId: 'sub_current', subscriptionStatus: 'active' }),
    }));
  });

  it('does not call Stripe for a subscription event that cannot map to the demo user', async () => {
    const retrieveSubscription = vi.fn(async () => subscription('active'));
    const tx = {
      stripeWebhookEvent: { create: vi.fn() },
      $queryRaw: vi.fn(async () => []),
      user: { update: vi.fn(), findUnique: vi.fn() },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      stripeWebhookEvent: { findUnique: vi.fn() },
    } as unknown as typeof prisma;

    await createRepository(database).processStripeEvent(subscriptionEvent(), retrieveSubscription);

    expect(retrieveSubscription).not.toHaveBeenCalled();
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it.each([
    'customer.subscription.updated',
    'checkout.session.completed',
  ] as const)('durably ignores a malformed %s event without Stripe or account work', async (type) => {
    const retrieveSubscription = vi.fn(async () => subscription('active'));
    const tx = {
      stripeWebhookEvent: { create: vi.fn() },
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

    expect(tx.stripeWebhookEvent.create).toHaveBeenCalledWith({
      data: { id: 'evt_malformed', type },
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(retrieveSubscription).not.toHaveBeenCalled();
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('treats a concurrent event-id conflict as success only when that event is durably present', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'P2002' });
    const database = {
      $transaction: vi.fn(async () => { throw duplicate; }),
      stripeWebhookEvent: { findUnique: vi.fn(async () => ({ id: 'evt_duplicate' })) },
    } as unknown as typeof prisma;

    await expect(createRepository(database).processStripeEvent(
      subscriptionEvent('evt_duplicate'),
      async () => subscription('active'),
    ))
      .resolves.toBeUndefined();
  });

  it('does not hide unrelated unique-constraint failures', async () => {
    const conflict = Object.assign(new Error('different unique constraint'), { code: 'P2002' });
    const database = {
      $transaction: vi.fn(async () => { throw conflict; }),
      stripeWebhookEvent: { findUnique: vi.fn(async () => null) },
    } as unknown as typeof prisma;

    await expect(createRepository(database).processStripeEvent(
      subscriptionEvent(),
      async () => subscription('active'),
    ))
      .rejects.toBe(conflict);
  });
});
