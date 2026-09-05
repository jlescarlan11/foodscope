import type Stripe from 'stripe';
import type { Locale } from './constants.js';

export type Nutrition = Partial<{
  energyKcal: number;
  fat: number;
  saturatedFat: number;
  carbohydrates: number;
  sugars: number;
  protein: number;
  salt: number;
  sodium: number;
}>;

export type Product = {
  id: string;
  name: string | null;
  brand: string | null;
  image: string | null;
  nutrition?: Nutrition;
  nutritionLocked: boolean;
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
};

export type CheckoutAttempt = { id: string; expiresAt: Date; sessionUrl: string | null };

export type RecentSearch = { id: number; query: string; locale: string; createdAt: Date };

export interface Repository {
  getDemoUser(): Promise<DemoUser | null>;
  saveSearch(userId: string, query: string, locale: Locale): Promise<void>;
  getRecentSearches(userId: string, limit: number): Promise<RecentSearch[]>;
  setStripeCustomer(userId: string, customerId: string): Promise<void>;
  getOrCreateCheckoutAttempt(userId: string): Promise<CheckoutAttempt>;
  completeCheckoutAttempt(
    userId: string,
    attemptId: string,
    session: { id: string; url: string; expiresAt: Date },
  ): Promise<void>;
  processStripeEvent(event: Stripe.Event, currentSubscription?: Stripe.Subscription): Promise<void>;
}

export interface ProductProvider {
  search(query: string, locale: Locale): Promise<Array<Omit<Product, 'nutritionLocked'>>>;
}

export interface BillingProvider {
  createCheckout(user: DemoUser): Promise<{ url: string }>;
  constructEvent(body: Buffer, signature: string): Stripe.Event;
  retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription>;
}
