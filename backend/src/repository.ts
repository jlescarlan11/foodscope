import type Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DEMO_USER_ID } from './constants.js';
import { prisma } from './prisma.js';
import type { Locale, } from './constants.js';
import type { Repository } from './types.js';

function subscriptionPeriodEnd(subscription: Stripe.Subscription) {
  const itemEnds = subscription.items.data.map((item) => item.current_period_end).filter(Boolean);
  const timestamp = itemEnds.length ? Math.max(...itemEnds) : undefined;
  return timestamp ? new Date(timestamp * 1000) : null;
}

const CHECKOUT_ATTEMPT_MS = 31 * 60 * 1000;

async function resolveUserFromSubscription(
  database: Pick<Prisma.TransactionClient, 'user'>,
  subscription: Stripe.Subscription,
) {
  const metadataUserId = subscription.metadata.demoUserId;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const select = {
    id: true,
    stripeCustomerId: true,
    stripeSubscriptionId: true,
    stripeCheckoutAttemptId: true,
  } as const;
  const user = metadataUserId === DEMO_USER_ID
    ? await database.user.findUnique({ where: { id: DEMO_USER_ID }, select })
    : await database.user.findUnique({ where: { stripeCustomerId: customerId }, select });
  return user?.stripeCustomerId === customerId ? user : null;
}

async function lockSubscriptionUser(
  database: Pick<Prisma.TransactionClient, '$queryRaw'>,
  subscription: Stripe.Subscription,
) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id;
  const rows = subscription.metadata.demoUserId === DEMO_USER_ID
    ? await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM User
        WHERE id = ${DEMO_USER_ID} AND stripeCustomerId = ${customerId}
        FOR UPDATE
      `)
    : await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM User WHERE stripeCustomerId = ${customerId} FOR UPDATE
      `);
  return rows.length > 0;
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
    async getOrCreateCheckoutAttempt(userId) {
      const existing = await database.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          subscriptionStatus: true,
          stripeCheckoutAttemptId: true,
          stripeCheckoutSessionUrl: true,
          stripeCheckoutExpiresAt: true,
        },
      });
      const now = new Date();
      if (existing.subscriptionStatus === 'active' || existing.subscriptionStatus === 'trialing') {
        throw new Error('The demo user already has nutrition access');
      }
      if (
        existing.stripeCheckoutAttemptId && existing.stripeCheckoutExpiresAt &&
        existing.stripeCheckoutExpiresAt > now
      ) {
        return {
          id: existing.stripeCheckoutAttemptId,
          expiresAt: existing.stripeCheckoutExpiresAt,
          sessionUrl: existing.stripeCheckoutSessionUrl,
        };
      }

      const attempt = { id: randomUUID(), expiresAt: new Date(now.getTime() + CHECKOUT_ATTEMPT_MS) };
      const claimed = await database.user.updateMany({
        where: {
          id: userId,
          subscriptionStatus: { notIn: ['active', 'trialing'] },
          OR: [
            { stripeCheckoutExpiresAt: null },
            { stripeCheckoutExpiresAt: { lte: now } },
          ],
        },
        data: {
          stripeCheckoutAttemptId: attempt.id,
          stripeCheckoutSessionId: null,
          stripeCheckoutSessionUrl: null,
          stripeCheckoutExpiresAt: attempt.expiresAt,
        },
      });
      if (claimed.count === 1) return { ...attempt, sessionUrl: null };

      const winner = await database.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          subscriptionStatus: true,
          stripeCheckoutAttemptId: true,
          stripeCheckoutSessionUrl: true,
          stripeCheckoutExpiresAt: true,
        },
      });
      if (winner.subscriptionStatus === 'active' || winner.subscriptionStatus === 'trialing') {
        throw new Error('The demo user already has nutrition access');
      }
      if (!winner.stripeCheckoutAttemptId || !winner.stripeCheckoutExpiresAt) {
        throw new Error('Unable to reserve Checkout attempt');
      }
      return {
        id: winner.stripeCheckoutAttemptId,
        expiresAt: winner.stripeCheckoutExpiresAt,
        sessionUrl: winner.stripeCheckoutSessionUrl,
      };
    },
    async completeCheckoutAttempt(userId, attemptId, session) {
      const saved = await database.user.updateMany({
        where: { id: userId, stripeCheckoutAttemptId: attemptId },
        data: {
          stripeCheckoutSessionId: session.id,
          stripeCheckoutSessionUrl: session.url,
          stripeCheckoutExpiresAt: session.expiresAt,
        },
      });
      if (saved.count !== 1) throw new Error('Checkout attempt expired before it could be saved');
    },
    async isStripeEventProcessed(eventId) {
      return Boolean(await database.stripeWebhookEvent.findUnique({
        where: { id: eventId },
        select: { id: true },
      }));
    },
    async processStripeEvent(event, retrieveSubscription) {
      try {
        await database.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });

          if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
            const subscriptionId = typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id;
            if (session.metadata?.demoUserId === DEMO_USER_ID && customerId && subscriptionId) {
              await tx.user.updateMany({
                where: {
                  id: DEMO_USER_ID,
                  stripeCustomerId: customerId,
                  stripeCheckoutSessionId: session.id,
                },
                data: { stripeSubscriptionId: subscriptionId },
              });
            }
          }

          if (
            event.type === 'customer.subscription.created' ||
            event.type === 'customer.subscription.updated' ||
            event.type === 'customer.subscription.deleted'
          ) {
            const deliveredSubscription = event.data.object;
            if (!retrieveSubscription) {
              throw new Error('Current Stripe subscription is required');
            }
            if (!await lockSubscriptionUser(tx, deliveredSubscription)) return;
            const currentSubscription = await retrieveSubscription(deliveredSubscription.id);
            if (currentSubscription.id !== deliveredSubscription.id) {
              throw new Error('Current Stripe subscription is required');
            }
            const user = await resolveUserFromSubscription(tx, currentSubscription);
            const isCheckoutHandoff = Boolean(
              user?.stripeCheckoutAttemptId &&
              currentSubscription.metadata.checkoutAttemptId === user.stripeCheckoutAttemptId
            );
            if (user && (
              user.stripeSubscriptionId === null ||
              user.stripeSubscriptionId === currentSubscription.id ||
              isCheckoutHandoff
            )) {
              const customerId = typeof currentSubscription.customer === 'string'
                ? currentSubscription.customer
                : currentSubscription.customer.id;
              await tx.user.update({
                where: { id: user.id },
                data: {
                  stripeCustomerId: customerId,
                  stripeSubscriptionId: currentSubscription.id,
                  subscriptionStatus: currentSubscription.status,
                  subscriptionCurrentPeriodEnd: subscriptionPeriodEnd(currentSubscription),
                  stripeCheckoutAttemptId: null,
                  stripeCheckoutSessionId: null,
                  stripeCheckoutSessionUrl: null,
                  stripeCheckoutExpiresAt: null,
                },
              });
            }
          }
        }, { maxWait: 5_000, timeout: 15_000 });
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
