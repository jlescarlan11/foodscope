import { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_USER_EMAIL, DEMO_USER_ID } from '../src/constants.js';
import { createRepository } from '../src/repository.js';
import { NutritionAccessAlreadyActiveError } from '../src/errors.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(testDatabaseUrl));

function subscription(status: Stripe.Subscription.Status) {
  return {
    id: 'sub_integration',
    customer: 'cus_integration',
    metadata: { demoUserId: DEMO_USER_ID },
    status,
    items: { data: [{ current_period_end: 1_800_000_000 }] },
  } as unknown as Stripe.Subscription;
}

function event(id: string, status: Stripe.Subscription.Status) {
  return {
    id,
    type: 'customer.subscription.updated',
    data: { object: subscription(status) },
  } as unknown as Stripe.Event;
}

function checkoutEvent(id: string, sessionId: string) {
  return {
    id,
    type: 'checkout.session.completed',
    data: { object: {
      id: sessionId,
      customer: 'cus_integration',
      subscription: 'sub_checkout',
      metadata: { demoUserId: DEMO_USER_ID },
    } },
  } as unknown as Stripe.Event;
}

integration('Repository with MySQL', () => {
  const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  const subject = createRepository(database);

  beforeAll(async () => {
    await database.user.create({
      data: {
        id: DEMO_USER_ID,
        email: DEMO_USER_EMAIL,
        stripeCustomerId: 'cus_integration',
        subscriptionStatus: 'inactive',
      },
    });
  });

  afterAll(() => database.$disconnect());

  it('commits one idempotency record under concurrent duplicate delivery', async () => {
    const duplicate = event('evt_concurrent', 'active');
    const current = subscription('canceled');

    await expect(Promise.all([
      subject.processStripeEvent(duplicate, async () => current),
      subject.processStripeEvent(duplicate, async () => current),
    ])).resolves.toEqual([undefined, undefined]);

    const [storedUser, eventCount] = await Promise.all([
      database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }),
      database.stripeWebhookEvent.count({ where: { id: duplicate.id } }),
    ]);
    expect(storedUser.subscriptionStatus).toBe('canceled');
    expect(eventCount).toBe(1);
  });

  it('cannot restore stale access when events arrive out of order', async () => {
    const current = subscription('unpaid');

    await subject.processStripeEvent(event('evt_newer', 'unpaid'), async () => current);
    await subject.processStripeEvent(event('evt_older', 'active'), async () => current);

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ subscriptionStatus: 'unpaid' });
  });

  it('serializes current-state reads so a delayed active read cannot overwrite cancellation', async () => {
    let releaseFirst!: () => void;
    let firstReadStarted!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstReadStarted = resolve; });
    let secondReadStarted = false;

    const first = subject.processStripeEvent(event('evt_interleaved_active', 'active'), async () => {
      firstReadStarted();
      await release;
      return subscription('active');
    });
    await started;
    const second = subject.processStripeEvent(event('evt_interleaved_canceled', 'canceled'), async () => {
      secondReadStarted = true;
      return subscription('canceled');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondReadStarted).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondReadStarted).toBe(true);
    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ subscriptionStatus: 'canceled' });
  });

  it('rolls back the event marker when the authoritative Stripe read fails', async () => {
    await expect(subject.processStripeEvent(
      event('evt_retrieve_failure', 'active'),
      async () => { throw new Error('Stripe unavailable'); },
    )).rejects.toThrow('Stripe unavailable');

    await expect(database.stripeWebhookEvent.findUnique({ where: { id: 'evt_retrieve_failure' } }))
      .resolves.toBeNull();
  });

  it('commits the event marker when a relevant event has no usable object', async () => {
    let stripeReads = 0;
    const malformed = {
      id: 'evt_malformed_object',
      type: 'customer.subscription.updated',
      data: { object: null },
    } as unknown as Stripe.Event;

    await subject.processStripeEvent(malformed, async () => {
      stripeReads += 1;
      return subscription('active');
    });

    expect(stripeReads).toBe(0);
    await expect(database.stripeWebhookEvent.findUnique({
      where: { id: malformed.id },
    })).resolves.toMatchObject({
      id: malformed.id,
      type: malformed.type,
    });
  });

  it('returns the eight newest searches deterministically when timestamps tie', async () => {
    const createdAt = new Date('2030-01-01T00:00:00.000Z');
    for (let index = 1; index <= 9; index += 1) {
      await database.recentSearch.create({
        data: { userId: DEMO_USER_ID, query: `query-${index}`, locale: 'en', createdAt },
      });
    }

    await expect(subject.getRecentSearches(DEMO_USER_ID, 8)).resolves.toMatchObject(
      Array.from({ length: 8 }, (_value, index) => ({ query: `query-${9 - index}` })),
    );
  });

  it('stores one history row for concurrent retries but preserves separate operations', async () => {
    const retryId = '00000000-0000-4000-8000-000000000010';
    await Promise.all([
      subject.saveSearch(DEMO_USER_ID, retryId, 'retry query', 'en'),
      subject.saveSearch(DEMO_USER_ID, retryId, 'retry query', 'en'),
    ]);
    await subject.saveSearch(
      DEMO_USER_ID,
      '00000000-0000-4000-8000-000000000011',
      'retry query',
      'en',
    );
    await expect(subject.saveSearch(DEMO_USER_ID, retryId, 'different query', 'en'))
      .rejects.toMatchObject({ code: 'P2002' });

    await expect(database.recentSearch.count({
      where: { userId: DEMO_USER_ID, query: 'retry query' },
    })).resolves.toBe(2);
  });

  it('reserves and reuses one Checkout attempt under concurrency', async () => {
    const [first, second] = await Promise.all([
      subject.getOrCreateCheckoutAttempt(DEMO_USER_ID),
      subject.getOrCreateCheckoutAttempt(DEMO_USER_ID),
    ]);
    expect(second.id).toBe(first.id);

    await subject.completeCheckoutAttempt(DEMO_USER_ID, first.id, {
      id: 'cs_test_integration',
      url: 'https://checkout.stripe.test/integration',
      expiresAt: first.expiresAt,
    });

    await expect(subject.getOrCreateCheckoutAttempt(DEMO_USER_ID)).resolves.toEqual({
      ...first,
      sessionUrl: 'https://checkout.stripe.test/integration',
    });

    await subject.processStripeEvent(checkoutEvent('evt_wrong_checkout', 'cs_test_other'));
    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ stripeSubscriptionId: 'sub_integration' });

    await subject.processStripeEvent(checkoutEvent('evt_current_checkout', 'cs_test_integration'));
    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ stripeSubscriptionId: 'sub_checkout' });

    await database.user.update({
      where: { id: DEMO_USER_ID },
      data: { subscriptionStatus: 'active' },
    });
    await expect(subject.getOrCreateCheckoutAttempt(DEMO_USER_ID))
      .rejects.toBeInstanceOf(NutritionAccessAlreadyActiveError);
  });
});
