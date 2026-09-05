import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type { AppConfig } from './config.js';
import { CheckoutUnavailableError } from './errors.js';
import type { BillingProvider, DemoUser, Repository } from './types.js';

const STRIPE_REQUEST_TIMEOUT_MS = 5_000;
const TERMINAL_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
  'canceled',
  'incomplete_expired',
]);

function integrationIdentifier(attemptId: string) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const digest = createHash('sha256').update(attemptId).digest();
  return `foodscope_${Array.from(digest.subarray(0, 8), (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

function safeCheckoutUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: Repository,
    stripeClient?: Stripe,
  ) {
    if (!config.stripeSecretKey) throw new Error('Stripe is not configured');
    if (!/^(?:sk|rk)_test_/.test(config.stripeSecretKey)) {
      throw new Error('Foodscope only supports Stripe test mode');
    }
    this.stripe = stripeClient ?? new Stripe(config.stripeSecretKey, {
      timeout: STRIPE_REQUEST_TIMEOUT_MS,
      maxNetworkRetries: 1,
    });
  }

  async createCheckout(user: DemoUser) {
    if (!this.config.stripePriceId) throw new Error('Stripe price is not configured');

    const attempt = await this.repository.getOrCreateCheckoutAttempt(user.id);
    const storedSessionUrl = safeCheckoutUrl(attempt.sessionUrl);
    if (storedSessionUrl) return { url: storedSessionUrl };

    let customerId = user.stripeCustomerId;
    if (customerId) {
      const subscriptions = await this.stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      });
      if (
        subscriptions.has_more ||
        subscriptions.data.some(({ status }) => !TERMINAL_SUBSCRIPTION_STATUSES.has(status))
      ) {
        throw new CheckoutUnavailableError();
      }
    } else {
      const customer = await this.stripe.customers.create({
        email: user.email,
        metadata: { demoUserId: user.id },
      }, { idempotencyKey: 'foodscope-demo-customer-v1' });
      customerId = customer.id;
      await this.repository.setStripeCustomer(user.id, customerId);
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: this.config.stripePriceId, quantity: 1 }],
      metadata: { demoUserId: user.id },
      subscription_data: { metadata: { demoUserId: user.id, checkoutAttemptId: attempt.id } },
      success_url: `${this.config.frontendUrl}/?checkout=success`,
      cancel_url: `${this.config.frontendUrl}/?checkout=cancelled`,
      expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
      integration_identifier: integrationIdentifier(attempt.id),
    }, { idempotencyKey: `foodscope-checkout-${attempt.id}` });
    const sessionUrl = safeCheckoutUrl(session.url);
    if (!sessionUrl) throw new Error('Stripe did not return a safe Checkout URL');
    await this.repository.completeCheckoutAttempt(user.id, attempt.id, {
      id: session.id,
      url: sessionUrl,
      expiresAt: new Date(session.expires_at * 1000),
    });
    return { url: sessionUrl };
  }

  constructEvent(body: Buffer, signature: string) {
    if (!this.config.stripeWebhookSecret) throw new Error('Stripe webhook is not configured');
    return this.stripe.webhooks.constructEvent(body, signature, this.config.stripeWebhookSecret);
  }

  retrieveSubscription(subscriptionId: string) {
    return this.stripe.subscriptions.retrieve(subscriptionId);
  }
}

export function createBillingProvider(config: AppConfig, repository: Repository) {
  const stripeValues = [config.stripeSecretKey, config.stripeWebhookSecret, config.stripePriceId];
  if (stripeValues.every((value) => !value)) return null;
  if (stripeValues.some((value) => !value)) {
    throw new Error('Stripe configuration requires a test key, webhook secret, and Price ID');
  }
  return new StripeBillingProvider(config, repository);
}
