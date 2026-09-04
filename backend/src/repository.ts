import type Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import { DEMO_USER_ID } from './constants.js';
import { prisma } from './prisma.js';
import type { Locale, } from './constants.js';
import type { Repository } from './types.js';

function subscriptionPeriodEnd(subscription: Stripe.Subscription) {
  const itemEnds = subscription.items.data.map((item) => item.current_period_end).filter(Boolean);
  const timestamp = itemEnds.length ? Math.max(...itemEnds) : undefined;
  return timestamp ? new Date(timestamp * 1000) : null;
}

async function resolveUserIdFromSubscription(
  database: Pick<Prisma.TransactionClient, 'user'>,
  subscription: Stripe.Subscription,
) {
  const metadataUserId = subscription.metadata.demoUserId;
  if (metadataUserId === DEMO_USER_ID) return DEMO_USER_ID;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const user = await database.user.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
  return user?.id ?? null;
}

export const repository: Repository = {
  getDemoUser: () => prisma.user.findUnique({ where: { id: DEMO_USER_ID } }),
  async saveSearch(userId: string, query: string, locale: Locale) {
    await prisma.recentSearch.create({ data: { userId, query, locale } });
  },
  getRecentSearches: (userId, limit) =>
    prisma.recentSearch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, query: true, locale: true, createdAt: true },
    }),
  async setStripeCustomer(userId, customerId) {
    await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
  },
  async processStripeEvent(event) {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const alreadyProcessed = await tx.stripeWebhookEvent.findUnique({ where: { id: event.id } });
      if (alreadyProcessed) return;

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.demoUserId;
        if (userId === DEMO_USER_ID) {
          const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
          await tx.user.update({
            where: { id: userId },
            data: { stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
          });
        }
      }

      if (
        event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        const subscription = event.data.object;
        const userId = await resolveUserIdFromSubscription(tx, subscription);
        if (userId) {
          const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
          await tx.user.update({
            where: { id: userId },
            data: {
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscription.id,
              subscriptionStatus: subscription.status,
              subscriptionCurrentPeriodEnd: subscriptionPeriodEnd(subscription),
            },
          });
        }
      }

      await tx.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });
    });
  },
};
