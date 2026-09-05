import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { DEMO_USER_EMAIL, DEMO_USER_ID } from '../src/constants.js';
import { ensureDemoUser } from '../src/demo-user.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(testDatabaseUrl));

integration('demo user initialization with MySQL', () => {
  const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });

  afterAll(() => database.$disconnect());

  it('preserves entitlement, Stripe mappings, searches, and webhook records on repeated runs', async () => {
    await ensureDemoUser(database);
    await database.user.update({
      where: { id: DEMO_USER_ID },
      data: {
        stripeCustomerId: 'cus_preserved',
        stripeSubscriptionId: 'sub_preserved',
        subscriptionStatus: 'active',
      },
    });
    await database.recentSearch.create({
      data: { userId: DEMO_USER_ID, query: 'preserved', locale: 'en' },
    });
    await database.stripeWebhookEvent.create({
      data: { id: 'evt_preserved', type: 'customer.subscription.updated' },
    });

    await ensureDemoUser(database);

    await expect(database.user.findUniqueOrThrow({ where: { id: DEMO_USER_ID } })).resolves.toMatchObject({
      email: DEMO_USER_EMAIL,
      stripeCustomerId: 'cus_preserved',
      stripeSubscriptionId: 'sub_preserved',
      subscriptionStatus: 'active',
    });
    await expect(database.recentSearch.count({
      where: { userId: DEMO_USER_ID, query: 'preserved', locale: 'en' },
    })).resolves.toBe(1);
    await expect(database.stripeWebhookEvent.count({ where: { id: 'evt_preserved' } })).resolves.toBe(1);
  });
});
