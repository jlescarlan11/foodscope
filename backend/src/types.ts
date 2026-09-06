import type Stripe from 'stripe';
import type { Locale, NUTRITION_RULES } from './constants.js';

export type NutritionValue = { value: number; unit: 'g' | 'kcal' };

export type Nutrition = Partial<Record<keyof typeof NUTRITION_RULES, NutritionValue>>;

export type Product = {
  id: string;
  name: string | null;
  brand: string | null;
  image: string | null;
  nutrition?: Nutrition;
  nutritionLocked: boolean;
};

export type ProductSearchPage = {
  products: Array<Omit<Product, 'nutritionLocked'>>;
  hasMore: boolean;
};

export type DemoUser = {
  id: string;
  email: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeCheckoutAttemptId: string | null;
  stripeCheckoutSessionId: string | null;
  stripeCheckoutSessionUrl: string | null;
  stripeCheckoutExpiresAt: Date | null;
  subscriptionStatus: string;
  subscriptionCurrentPeriodEnd: Date | null;
  subscriptionCancelAtPeriodEnd: boolean;
};

export type DemoUserState = Pick<
  DemoUser,
  | 'id'
  | 'stripeSubscriptionId'
  | 'subscriptionStatus'
  | 'subscriptionCurrentPeriodEnd'
  | 'subscriptionCancelAtPeriodEnd'
>;

export type CheckoutAttempt = {
  id: string;
  expiresAt: Date;
  sessionUrl: string | null;
  priceId: string | null;
  customerId: string | null;
};

export type RecentSearch = { id: number; query: string; locale: string; createdAt: Date };

export interface Repository {
  getDemoUser(): Promise<DemoUserState | null>;
  getDemoUserForCheckout(): Promise<DemoUser | null>;
  saveSearch(userId: string, requestId: string, query: string, locale: Locale): Promise<void>;
  getRecentSearches(userId: string, limit: number): Promise<RecentSearch[]>;
  setStripeCustomer(userId: string, customerId: string): Promise<void>;
  replaceStripeCustomer(
    userId: string,
    expectedCustomerId: string,
    expectedCheckoutAttemptId: string,
    replacementCustomerId: string,
  ): Promise<string>;
  getOrCreateCheckoutAttempt(userId: string): Promise<CheckoutAttempt>;
  completeCheckoutAttempt(
    userId: string,
    attemptId: string,
    session: { id: string; url: string; expiresAt: Date },
  ): Promise<void>;
  releaseCheckoutAttempt(userId: string, attemptId: string): Promise<void>;
  processStripeEvent(
    event: Stripe.Event,
    retrieveSubscription?: (subscriptionId: string) => Promise<Stripe.Subscription>,
  ): Promise<void>;
  syncSubscription(userId: string, subscription: Stripe.Subscription): Promise<void>;
}

export interface ProductProvider {
  search(
    query: string,
    locale: Locale,
    signal?: AbortSignal,
    page?: number,
    pageSize?: number,
  ): Promise<ProductSearchPage>;
}

export interface BillingProvider {
  createCheckout(user: DemoUser): Promise<{ url: string }>;
  updateSubscriptionCancellation(
    user: DemoUser,
    cancelAtPeriodEnd: boolean,
    requestId: string,
  ): Promise<void>;
  constructEvent(body: Buffer, signature: string): Stripe.Event;
  retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription>;
}
