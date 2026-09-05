import { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_USER_EMAIL, DEMO_USER_ID } from '../src/constants.js';
import { createRepository } from '../src/repository.js';

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
  } as Stripe.Event;
}

integration('Stripe webhook repository with MySQL', () => {
  const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  const subject = createRepository(database);

  beforeAll(async () => {
    await database.user.create({
      data: { id: DEMO_USER_ID, email: DEMO_USER_EMAIL, subscriptionStatus: 'inactive' },
    });
  });

  afterAll(() => database.$disconnect());

  it('commits one idempotency record under concurrent duplicate delivery', async () => {
    const duplicate = event('evt_concurrent', 'active');
    const current = subscription('canceled');

    await expect(Promise.all([
      subject.processStripeEvent(duplicate, current),
      subject.processStripeEvent(duplicate, current),
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

    await subject.processStripeEvent(event('evt_newer', 'unpaid'), current);
    await subject.processStripeEvent(event('evt_older', 'active'), current);

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } }))
      .resolves.toMatchObject({ subscriptionStatus: 'unpaid' });
  });
});
