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

    await createRepository(database).processStripeEvent(subscriptionEvent(), subscription('canceled'));

    expect(operations).toEqual(['event', 'update']);
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

    await createRepository(database).processStripeEvent(subscriptionEvent(), subscription('active'));

    expect(update).not.toHaveBeenCalled();
  });

  it('accepts a new subscription only when it matches the durable Checkout attempt', async () => {
    const update = vi.fn();
    const tx = {
      stripeWebhookEvent: { create: vi.fn() },
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

    await createRepository(database).processStripeEvent(subscriptionEvent(), current);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: DEMO_USER_ID },
      data: expect.objectContaining({ stripeSubscriptionId: 'sub_current', subscriptionStatus: 'active' }),
    }));
  });

  it('treats a concurrent event-id conflict as success only when that event is durably present', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 'P2002' });
    const database = {
      $transaction: vi.fn(async () => { throw duplicate; }),
      stripeWebhookEvent: { findUnique: vi.fn(async () => ({ id: 'evt_duplicate' })) },
    } as unknown as typeof prisma;

    await expect(createRepository(database).processStripeEvent(subscriptionEvent('evt_duplicate'), subscription('active')))
      .resolves.toBeUndefined();
  });

  it('does not hide unrelated unique-constraint failures', async () => {
    const conflict = Object.assign(new Error('different unique constraint'), { code: 'P2002' });
    const database = {
      $transaction: vi.fn(async () => { throw conflict; }),
      stripeWebhookEvent: { findUnique: vi.fn(async () => null) },
    } as unknown as typeof prisma;

    await expect(createRepository(database).processStripeEvent(subscriptionEvent(), subscription('active')))
      .rejects.toBe(conflict);
  });
});
