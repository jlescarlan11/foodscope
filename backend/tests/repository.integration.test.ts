import { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEMO_USER_EMAIL, DEMO_USER_ID } from '../src/constants.js';
import { createRepository } from '../src/repository.js';
import { CheckoutUnavailableError } from '../src/errors.js';
import { resolveTestDatabaseUrl } from './test-database.js';

const testDatabaseUrl = resolveTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const integration = describe.runIf(Boolean(testDatabaseUrl));

function subscription(status: Stripe.Subscription.Status) {
  return {
    id: 'sub_integration',
    object: 'subscription',
    livemode: false,
    customer: 'cus_integration',
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
      object: 'checkout.session',
      customer: 'cus_integration',
      subscription: 'sub_checkout',
      metadata: { demoUserId: DEMO_USER_ID },
      livemode: false,
      mode: 'subscription',
      status: 'complete',
    } },
  } as unknown as Stripe.Event;
}

integration('Repository with MySQL', () => {
  const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  const subject = createRepository(database, 'price_test');

  beforeAll(async () => {
    await database.user.upsert({
      where: { id: DEMO_USER_ID },
      update: {
        email: DEMO_USER_EMAIL,
        stripeCustomerId: 'cus_integration',
        stripeSubscriptionId: 'sub_integration',
        stripeCheckoutAttemptId: null,
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionUrl: null,
        stripeCheckoutExpiresAt: null,
        subscriptionStatus: 'inactive',
        subscriptionCurrentPeriodEnd: null,
      },
      create: {
        id: DEMO_USER_ID,
        email: DEMO_USER_EMAIL,
        stripeCustomerId: 'cus_integration',
        stripeSubscriptionId: 'sub_integration',
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

  it('never mutates a non-demo user through customer fallback', async () => {
    const otherUserId = '00000000-0000-4000-8000-000000000099';
    await database.stripeWebhookEvent.deleteMany({ where: { id: 'evt_other_user' } });
    await database.user.upsert({
      where: { id: otherUserId },
      update: {
        subscriptionStatus: 'inactive',
        stripeCustomerId: 'cus_other',
        stripeSubscriptionId: 'sub_other',
      },
      create: {
        id: otherUserId,
        email: 'other@foodscope.local',
        subscriptionStatus: 'inactive',
        stripeCustomerId: 'cus_other',
        stripeSubscriptionId: 'sub_other',
      },
    });
    const otherSubscription = {
      ...subscription('active'),
      id: 'sub_other',
      customer: 'cus_other',
      metadata: { demoUserId: otherUserId },
    } as Stripe.Subscription;
    const retrieveSubscription = vi.fn(async () => otherSubscription);

    await subject.processStripeEvent({
      id: 'evt_other_user',
      type: 'customer.subscription.updated',
      data: { object: otherSubscription },
    } as Stripe.Event, retrieveSubscription);

    await expect(database.user.findUniqueOrThrow({ where: { id: otherUserId } }))
      .resolves.toMatchObject({ subscriptionStatus: 'inactive' });
    expect(retrieveSubscription).not.toHaveBeenCalled();
  });

  it('stores maximum-length, case-sensitive Stripe identifiers', async () => {
    const upperId = `${'e'.repeat(254)}A`;
    const lowerId = `${'e'.repeat(254)}a`;
    const ignoredObject = (id: string) => ({
      id,
      type: 'checkout.session.completed',
      data: { object: null },
    } as unknown as Stripe.Event);

    await subject.processStripeEvent(ignoredObject(upperId));
    await subject.processStripeEvent(ignoredObject(lowerId));
    await subject.setStripeCustomer(DEMO_USER_ID, 'c'.repeat(255));

    await expect(database.stripeWebhookEvent.count({
      where: { id: { in: [upperId, lowerId] } },
    })).resolves.toBe(2);
    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ stripeCustomerId: 'c'.repeat(255) });

    await subject.setStripeCustomer(DEMO_USER_ID, 'cus_integration');
  });

  it('converges concurrent replacement of the same Stripe Customer', async () => {
    await database.user.update({
      where: { id: DEMO_USER_ID },
      data: { stripeCheckoutAttemptId: 'attempt_replacement' },
    });
    await expect(Promise.all([
      subject.replaceStripeCustomer(
        DEMO_USER_ID, 'cus_integration', 'attempt_replacement', 'cus_replacement',
      ),
      subject.replaceStripeCustomer(
        DEMO_USER_ID, 'cus_integration', 'attempt_replacement', 'cus_replacement',
      ),
    ])).resolves.toEqual(['cus_replacement', 'cus_replacement']);
    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ stripeCustomerId: 'cus_replacement' });

    await subject.setStripeCustomer(DEMO_USER_ID, 'cus_integration');
  });

  it('cannot restore stale access when events arrive out of order', async () => {
    const current = subscription('unpaid');

    await subject.processStripeEvent(event('evt_newer', 'unpaid'), async () => current);
    await subject.processStripeEvent(event('evt_older', 'active'), async () => current);

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ subscriptionStatus: 'unpaid' });
  });

  it('persists a future overlength Stripe status as fail-closed unknown', async () => {
    const current = subscription('active') as unknown as Record<string, unknown>;
    current.status = 'future_status_that_does_not_fit_the_database_column_without_normalizing';

    await subject.processStripeEvent(
      event('evt_future_status', 'active'),
      async () => current as unknown as Stripe.Subscription,
    );

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ subscriptionStatus: 'unknown' });
  });

  it('durably revokes access when an active subscription period is missing', async () => {
    const current = subscription('active') as unknown as Record<string, unknown>;
    current.items = { data: [] };

    await subject.processStripeEvent(
      event('evt_missing_period', 'active'),
      async () => current as unknown as Stripe.Subscription,
    );

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({
        subscriptionStatus: 'unknown',
        subscriptionCurrentPeriodEnd: null,
      });
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

  it('does not adopt a subscription without a stored ID or Checkout handoff', async () => {
    await database.user.update({
      where: { id: DEMO_USER_ID },
      data: {
        stripeSubscriptionId: null,
        stripeCheckoutAttemptId: null,
        subscriptionStatus: 'inactive',
      },
    });

    await subject.processStripeEvent(
      event('evt_unproven_integration', 'active'),
      async () => subscription('active'),
    );

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ stripeSubscriptionId: null, subscriptionStatus: 'inactive' });

    await database.user.update({
      where: { id: DEMO_USER_ID },
      data: { stripeSubscriptionId: 'sub_integration' },
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
    expect(first.priceId).toBe('price_test');
    expect(first.customerId).toBe('cus_integration');
    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ stripeCheckoutPriceId: 'price_test' });

    await subject.releaseCheckoutAttempt(DEMO_USER_ID, first.id);
    const replacement = await subject.getOrCreateCheckoutAttempt(DEMO_USER_ID);
    expect(replacement.id).not.toBe(first.id);

    await subject.completeCheckoutAttempt(DEMO_USER_ID, replacement.id, {
      id: 'cs_test_integration',
      url: 'https://checkout.stripe.test/integration',
      expiresAt: replacement.expiresAt,
    });
    await subject.releaseCheckoutAttempt(DEMO_USER_ID, replacement.id);

    await expect(subject.getOrCreateCheckoutAttempt(DEMO_USER_ID)).resolves.toEqual({
      ...replacement,
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
      .rejects.toBeInstanceOf(CheckoutUnavailableError);
    await database.user.update({
      where: { id: DEMO_USER_ID },
      data: { subscriptionStatus: 'unpaid' },
    });
    await expect(subject.getOrCreateCheckoutAttempt(DEMO_USER_ID))
      .rejects.toBeInstanceOf(CheckoutUnavailableError);
  });

  it('keeps a recovery attempt through an old terminal event and accepts its handoff', async () => {
    await database.user.update({
      where: { id: DEMO_USER_ID },
      data: {
        stripeSubscriptionId: 'sub_integration',
        subscriptionStatus: 'canceled',
        stripeCheckoutAttemptId: null,
        stripeCheckoutPriceId: null,
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionUrl: null,
        stripeCheckoutExpiresAt: null,
      },
    });
    const attempt = await subject.getOrCreateCheckoutAttempt(DEMO_USER_ID);

    await subject.processStripeEvent(
      event('evt_old_terminal_during_recovery', 'canceled'),
      async () => subscription('canceled'),
    );
    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ stripeCheckoutAttemptId: attempt.id });

    const wrongOwner = subscription('active');
    wrongOwner.id = 'sub_wrong_owner';
    wrongOwner.metadata.checkoutAttemptId = attempt.id;
    wrongOwner.metadata.demoUserId = 'unexpected-user';
    await subject.processStripeEvent({
      id: 'evt_wrong_owner_handoff',
      type: 'customer.subscription.created',
      data: { object: wrongOwner },
    } as unknown as Stripe.Event, async () => wrongOwner);
    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({
        stripeSubscriptionId: 'sub_integration',
        stripeCheckoutAttemptId: attempt.id,
      });

    const replacement = subscription('active');
    replacement.id = 'sub_replacement';
    replacement.metadata.checkoutAttemptId = attempt.id;
    await subject.processStripeEvent({
      id: 'evt_replacement_handoff',
      type: 'customer.subscription.created',
      data: { object: replacement },
    } as unknown as Stripe.Event, async () => replacement);

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({
        stripeSubscriptionId: replacement.id,
        subscriptionStatus: 'active',
        stripeCheckoutAttemptId: null,
      });
  });

  it('revokes stored entitlement when the mapped Customer is deleted', async () => {
    await subject.processStripeEvent({
      id: 'evt_customer_deleted',
      type: 'customer.deleted',
      data: { object: { id: 'cus_integration', object: 'customer', deleted: true } },
    } as unknown as Stripe.Event);

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({
        stripeCustomerId: 'cus_integration',
        subscriptionStatus: 'canceled',
        subscriptionCurrentPeriodEnd: null,
      });
  });

  it('releases a matching Checkout attempt as soon as Stripe expires its Session', async () => {
    const attempt = await subject.getOrCreateCheckoutAttempt(DEMO_USER_ID);
    await subject.completeCheckoutAttempt(DEMO_USER_ID, attempt.id, {
      id: 'cs_expired_integration',
      url: 'https://checkout.stripe.test/expired-integration',
      expiresAt: attempt.expiresAt,
    });

    await subject.processStripeEvent({
      id: 'evt_old_checkout_expired',
      type: 'checkout.session.expired',
      data: { object: {
        id: 'cs_older_integration',
        object: 'checkout.session',
        customer: 'cus_integration',
        metadata: { demoUserId: DEMO_USER_ID },
        livemode: false,
        mode: 'subscription',
        status: 'expired',
      } },
    } as unknown as Stripe.Event);
    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({
        stripeCheckoutAttemptId: attempt.id,
        stripeCheckoutSessionId: 'cs_expired_integration',
      });

    await subject.processStripeEvent({
      id: 'evt_checkout_expired',
      type: 'checkout.session.expired',
      data: { object: {
        id: 'cs_expired_integration',
        object: 'checkout.session',
        customer: 'cus_integration',
        metadata: { demoUserId: DEMO_USER_ID },
        livemode: false,
        mode: 'subscription',
        status: 'expired',
      } },
    } as unknown as Stripe.Event);

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({
        stripeCustomerId: 'cus_integration',
        subscriptionStatus: 'canceled',
        stripeCheckoutAttemptId: null,
        stripeCheckoutPriceId: null,
        stripeCheckoutSessionId: null,
        stripeCheckoutSessionUrl: null,
        stripeCheckoutExpiresAt: null,
      });
  });

  it('durably ignores completed Checkout with an oversized subscription ID', async () => {
    const attempt = await subject.getOrCreateCheckoutAttempt(DEMO_USER_ID);
    await subject.completeCheckoutAttempt(DEMO_USER_ID, attempt.id, {
      id: 'cs_malformed_integration',
      url: 'https://checkout.stripe.test/malformed-integration',
      expiresAt: attempt.expiresAt,
    });

    await expect(subject.processStripeEvent({
      id: 'evt_checkout_oversized_subscription',
      type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_malformed_integration',
        object: 'checkout.session',
        customer: 'cus_integration',
        subscription: 's'.repeat(256),
        metadata: { demoUserId: DEMO_USER_ID },
        livemode: false,
        mode: 'subscription',
        status: 'complete',
      } },
    } as unknown as Stripe.Event)).resolves.toBeUndefined();

    const [storedUser, eventCount] = await Promise.all([
      database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }),
      database.stripeWebhookEvent.count({ where: { id: 'evt_checkout_oversized_subscription' } }),
    ]);
    expect(storedUser).toMatchObject({
      stripeSubscriptionId: 'sub_replacement',
      stripeCheckoutSessionId: 'cs_malformed_integration',
    });
    expect(eventCount).toBe(1);
  });
});
