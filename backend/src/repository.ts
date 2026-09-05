import type Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  canStartCheckout,
  CHECKOUT_ELIGIBLE_STATUSES,
  DEMO_USER_ID,
  isActiveSubscription,
  normalizeStripeSubscriptionStatus,
} from './constants.js';
import { CheckoutUnavailableError } from './errors.js';
import { prisma } from './prisma.js';
import { isMonthlyTestPrice } from './stripe-price.js';
import { isStripeOpaqueId } from './stripe-config.js';
import type { Locale, } from './constants.js';
import type { Repository } from './types.js';

function subscriptionPeriodEnd(subscription: Stripe.Subscription, stripePriceId: string | undefined) {
  if (!stripePriceId) return null;
  const items = isRecord(subscription.items) && Array.isArray(subscription.items.data)
    ? subscription.items.data
    : [];
  const configuredItems = items.filter((item) => {
    if (!isRecord(item)) return false;
    const price: unknown = item.price;
    return price === stripePriceId ||
      (isRecord(price) && price.id === stripePriceId);
  });
  if (configuredItems.length !== 1) return null;
  const [item] = configuredItems;
  if (
    !isRecord(item) || item.object !== 'subscription_item' ||
    !isMonthlyTestPrice(item.price, stripePriceId) ||
    typeof item.current_period_end !== 'number' ||
    !Number.isFinite(item.current_period_end) || item.current_period_end <= 0
  ) return null;
  const end = new Date(item.current_period_end * 1000);
  return Number.isFinite(end.getTime()) && end.getUTCFullYear() <= 9_999 ? end : null;
}

const CHECKOUT_ATTEMPT_MS = 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUniqueConstraintError(error: unknown) {
  return isRecord(error) && error.code === 'P2002';
}

function expandableId(value: unknown, objectType: string) {
  if (isStripeOpaqueId(value)) return value;
  if (isRecord(value) && value.object === objectType && isStripeOpaqueId(value.id)) return value.id;
  return null;
}

function activeCustomerId(value: unknown) {
  if (isStripeOpaqueId(value)) return value;
  if (
    isRecord(value) && value.object === 'customer' &&
    value.deleted !== true && value.livemode === false &&
    isStripeOpaqueId(value.id)
  ) return value.id;
  return null;
}

function eventObject(event: Stripe.Event): unknown {
  const rawEvent = event as unknown as Record<string, unknown>;
  const data = isRecord(rawEvent.data) ? rawEvent.data : null;
  return data ? data.object : undefined;
}

function isSubscriptionLocator(value: unknown): value is Stripe.Subscription {
  return isRecord(value) &&
    value.object === 'subscription' &&
    value.livemode === false &&
    isStripeOpaqueId(value.id) &&
    activeCustomerId(value.customer) !== null;
}

function isSubscriptionReference(value: unknown): value is Stripe.Subscription {
  return isSubscriptionLocator(value) && isRecord(value.metadata);
}

async function resolveUserFromSubscription(
  database: Pick<Prisma.TransactionClient, 'user'>,
  subscription: Stripe.Subscription,
) {
  const customerId = activeCustomerId(subscription.customer);
  if (!customerId) return null;
  const select = {
    id: true,
    stripeCustomerId: true,
    stripeSubscriptionId: true,
    stripeCheckoutAttemptId: true,
  } as const;
  const user = await database.user.findUnique({ where: { id: DEMO_USER_ID }, select });
  return user?.stripeCustomerId === customerId ? user : null;
}

async function lockSubscriptionUser(
  database: Pick<Prisma.TransactionClient, '$queryRaw'>,
  subscription: Stripe.Subscription,
) {
  const customerId = activeCustomerId(subscription.customer);
  if (!customerId) return false;
  const rows = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM User
    WHERE id = ${DEMO_USER_ID} AND stripeCustomerId = ${customerId}
    FOR UPDATE
  `);
  return rows.length > 0;
}

export function createRepository(database: typeof prisma, stripePriceId?: string): Repository {
  return {
    getDemoUser: () => database.user.findUnique({
      where: { id: DEMO_USER_ID },
      select: { id: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true },
    }),
    getDemoUserForCheckout: () => database.user.findUnique({
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
    }),
    async saveSearch(userId: string, requestId: string, query: string, locale: Locale) {
      try {
        await database.recentSearch.create({ data: { userId, requestId, query, locale } });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const existing = await database.recentSearch.findUnique({
          where: { userId_requestId: { userId, requestId } },
          select: { query: true, locale: true },
        });
        if (existing?.query === query && existing.locale === locale) return;
        throw error;
      }
    },
    getRecentSearches: (userId, limit) =>
      database.recentSearch.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: { id: true, query: true, locale: true, createdAt: true },
      }),
    async setStripeCustomer(userId, customerId) {
      await database.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    },
    async replaceStripeCustomer(
      userId,
      expectedCustomerId,
      expectedCheckoutAttemptId,
      replacementCustomerId,
    ) {
      const replaced = await database.user.updateMany({
        where: {
          id: userId,
          stripeCustomerId: expectedCustomerId,
          stripeCheckoutAttemptId: expectedCheckoutAttemptId,
        },
        data: {
          stripeCustomerId: replacementCustomerId,
          stripeCheckoutAttemptId: null,
          stripeCheckoutPriceId: null,
          stripeCheckoutSessionId: null,
          stripeCheckoutSessionUrl: null,
          stripeCheckoutExpiresAt: null,
        },
      });
      if (replaced.count === 1) return replacementCustomerId;

      const winner = await database.user.findUnique({
        where: { id: userId },
        select: { stripeCustomerId: true },
      });
      if (winner?.stripeCustomerId === replacementCustomerId) return replacementCustomerId;
      throw new CheckoutUnavailableError();
    },
    async getOrCreateCheckoutAttempt(userId) {
      const existing = await database.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          subscriptionStatus: true,
          stripeCustomerId: true,
          stripeCheckoutAttemptId: true,
          stripeCheckoutPriceId: true,
          stripeCheckoutSessionUrl: true,
          stripeCheckoutExpiresAt: true,
        },
      });
      const now = new Date();
      if (!canStartCheckout(existing.subscriptionStatus)) {
        throw new CheckoutUnavailableError();
      }
      if (
        existing.stripeCheckoutAttemptId && existing.stripeCheckoutExpiresAt &&
        existing.stripeCheckoutExpiresAt > now
      ) {
        if (existing.stripeCheckoutPriceId !== stripePriceId) {
          throw new CheckoutUnavailableError();
        }
        return {
          id: existing.stripeCheckoutAttemptId,
          expiresAt: existing.stripeCheckoutExpiresAt,
          sessionUrl: existing.stripeCheckoutSessionUrl,
          priceId: existing.stripeCheckoutPriceId,
          customerId: existing.stripeCustomerId,
        };
      }

      const attempt = { id: randomUUID(), expiresAt: new Date(now.getTime() + CHECKOUT_ATTEMPT_MS) };
      const claimed = await database.user.updateMany({
        where: {
          id: userId,
          subscriptionStatus: { in: [...CHECKOUT_ELIGIBLE_STATUSES] },
          OR: [
            { stripeCheckoutExpiresAt: null },
            { stripeCheckoutExpiresAt: { lte: now } },
          ],
        },
        data: {
          stripeCheckoutAttemptId: attempt.id,
          stripeCheckoutPriceId: stripePriceId ?? null,
          stripeCheckoutSessionId: null,
          stripeCheckoutSessionUrl: null,
          stripeCheckoutExpiresAt: attempt.expiresAt,
        },
      });
      if (claimed.count === 1) {
        return {
          ...attempt,
          sessionUrl: null,
          priceId: stripePriceId ?? null,
          customerId: existing.stripeCustomerId,
        };
      }

      const winner = await database.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          subscriptionStatus: true,
          stripeCustomerId: true,
          stripeCheckoutAttemptId: true,
          stripeCheckoutPriceId: true,
          stripeCheckoutSessionUrl: true,
          stripeCheckoutExpiresAt: true,
        },
      });
      if (!canStartCheckout(winner.subscriptionStatus)) {
        throw new CheckoutUnavailableError();
      }
      if (!winner.stripeCheckoutAttemptId || !winner.stripeCheckoutExpiresAt) {
        throw new Error('Unable to reserve Checkout attempt');
      }
      if (winner.stripeCheckoutPriceId !== stripePriceId) {
        throw new CheckoutUnavailableError();
      }
      return {
        id: winner.stripeCheckoutAttemptId,
        expiresAt: winner.stripeCheckoutExpiresAt,
        sessionUrl: winner.stripeCheckoutSessionUrl,
        priceId: winner.stripeCheckoutPriceId,
        customerId: winner.stripeCustomerId,
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
    async releaseCheckoutAttempt(userId, attemptId) {
      await database.user.updateMany({
        where: {
          id: userId,
          stripeCheckoutAttemptId: attemptId,
          stripeCheckoutSessionId: null,
          stripeCheckoutSessionUrl: null,
        },
        data: {
          stripeCheckoutAttemptId: null,
          stripeCheckoutPriceId: null,
          stripeCheckoutExpiresAt: null,
        },
      });
    },
    async processStripeEvent(event, retrieveSubscription) {
      await database.$transaction(async (tx: Prisma.TransactionClient) => {
        const marker = await tx.stripeWebhookEvent.createMany({
          data: [{ id: event.id, type: event.type }],
          skipDuplicates: true,
        });
        if (marker.count === 0) return;

          if (event.type === 'checkout.session.completed') {
            const session = eventObject(event);
            const sessionId = isRecord(session) && isStripeOpaqueId(session.id)
              ? session.id
              : null;
            const customerId = isRecord(session) ? activeCustomerId(session.customer) : null;
            const subscriptionId = isRecord(session)
              ? expandableId(session.subscription, 'subscription')
              : null;
            const metadata = isRecord(session) && isRecord(session.metadata) ? session.metadata : null;
            if (
              isRecord(session) && sessionId && customerId && subscriptionId &&
              session.object === 'checkout.session' &&
              session.livemode === false &&
              session.mode === 'subscription' &&
              session.status === 'complete' &&
              metadata?.demoUserId === DEMO_USER_ID
            ) {
              await tx.user.updateMany({
                where: {
                  id: DEMO_USER_ID,
                  stripeCustomerId: customerId,
                  stripeCheckoutSessionId: sessionId,
                },
                data: { stripeSubscriptionId: subscriptionId },
              });
            }
          }

          if (event.type === 'checkout.session.expired') {
            const session = eventObject(event);
            const sessionId = isRecord(session) && isStripeOpaqueId(session.id)
              ? session.id
              : null;
            const customerId = isRecord(session) ? activeCustomerId(session.customer) : null;
            const metadata = isRecord(session) && isRecord(session.metadata)
              ? session.metadata
              : null;
            if (
              isRecord(session) && sessionId && customerId &&
              session.object === 'checkout.session' &&
              session.livemode === false &&
              session.mode === 'subscription' &&
              session.status === 'expired' &&
              metadata?.demoUserId === DEMO_USER_ID
            ) {
              await tx.user.updateMany({
                where: {
                  id: DEMO_USER_ID,
                  stripeCustomerId: customerId,
                  stripeCheckoutSessionId: sessionId,
                },
                data: {
                  stripeCheckoutAttemptId: null,
                  stripeCheckoutPriceId: null,
                  stripeCheckoutSessionId: null,
                  stripeCheckoutSessionUrl: null,
                  stripeCheckoutExpiresAt: null,
                },
              });
            }
          }

          if (event.type === 'customer.deleted') {
            const customer = eventObject(event);
            const customerId = isRecord(customer) &&
              customer.object === 'customer' && customer.deleted === true
              ? expandableId(customer, 'customer')
              : null;
            if (customerId) {
              await tx.user.updateMany({
                where: { id: DEMO_USER_ID, stripeCustomerId: customerId },
                data: {
                  subscriptionStatus: 'canceled',
                  subscriptionCurrentPeriodEnd: null,
                },
              });
            }
          }

          if (
            event.type === 'customer.subscription.created' ||
            event.type === 'customer.subscription.updated' ||
            event.type === 'customer.subscription.deleted'
          ) {
            const deliveredSubscription = eventObject(event);
            if (!isSubscriptionLocator(deliveredSubscription)) return;
            if (!retrieveSubscription) {
              throw new Error('Current Stripe subscription is required');
            }
            if (!await lockSubscriptionUser(tx, deliveredSubscription)) return;
            const currentSubscription = await retrieveSubscription(deliveredSubscription.id);
            if (
              !isSubscriptionReference(currentSubscription) ||
              currentSubscription.id !== deliveredSubscription.id
            ) {
              throw new Error('Current Stripe subscription is required');
            }
            const user = await resolveUserFromSubscription(tx, currentSubscription);
            const isCheckoutHandoff = Boolean(
              user?.stripeCheckoutAttemptId &&
              currentSubscription.metadata.demoUserId === user.id &&
              currentSubscription.metadata.checkoutAttemptId === user.stripeCheckoutAttemptId
            );
            if (user && (
              user.stripeSubscriptionId === currentSubscription.id ||
              isCheckoutHandoff
            )) {
              const normalizedStatus = normalizeStripeSubscriptionStatus(
                currentSubscription.status,
              );
              const periodEnd = subscriptionPeriodEnd(currentSubscription, stripePriceId);
              const subscriptionStatus = isActiveSubscription(normalizedStatus) && !periodEnd
                ? 'unknown'
                : normalizedStatus;
              const shouldClearCheckoutAttempt = isCheckoutHandoff ||
                !canStartCheckout(subscriptionStatus);
              const customerId = typeof currentSubscription.customer === 'string'
                ? currentSubscription.customer
                : currentSubscription.customer.id;
              await tx.user.update({
                where: { id: user.id },
                data: {
                  stripeCustomerId: customerId,
                  stripeSubscriptionId: currentSubscription.id,
                  subscriptionStatus,
                  subscriptionCurrentPeriodEnd: periodEnd,
                  ...(shouldClearCheckoutAttempt ? {
                    stripeCheckoutAttemptId: null,
                    stripeCheckoutPriceId: null,
                    stripeCheckoutSessionId: null,
                    stripeCheckoutSessionUrl: null,
                    stripeCheckoutExpiresAt: null,
                  } : {}),
                },
              });
            }
          }
        }, { maxWait: 5_000, timeout: 15_000 });
    },
  };
}
