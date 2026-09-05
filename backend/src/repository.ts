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

export function createRepository(database: typeof prisma): Repository {
  return {
    getDemoUser: () => database.user.findUnique({ where: { id: DEMO_USER_ID } }),
    async saveSearch(userId: string, query: string, locale: Locale) {
      await database.recentSearch.create({ data: { userId, query, locale } });
    },
    getRecentSearches: (userId, limit) =>
      database.recentSearch.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, query: true, locale: true, createdAt: true },
      }),
    async setStripeCustomer(userId, customerId) {
      await database.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    },
    async processStripeEvent(event, currentSubscription) {
      try {
        await database.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });

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
          if (!currentSubscription || currentSubscription.id !== event.data.object.id) {
            throw new Error('Current Stripe subscription is required');
          }
          const userId = await resolveUserIdFromSubscription(tx, currentSubscription);
          if (userId) {
            const customerId = typeof currentSubscription.customer === 'string'
              ? currentSubscription.customer
              : currentSubscription.customer.id;
            await tx.user.update({
              where: { id: userId },
              data: {
                stripeCustomerId: customerId,
                stripeSubscriptionId: currentSubscription.id,
                subscriptionStatus: currentSubscription.status,
                subscriptionCurrentPeriodEnd: subscriptionPeriodEnd(currentSubscription),
              },
            });
          }
        }
        });
      } catch (error) {
        if (
          typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002' &&
          await database.stripeWebhookEvent.findUnique({ where: { id: event.id }, select: { id: true } })
        ) return;
        throw error;
      }
    },
  };
}

export const repository = createRepository(prisma);
