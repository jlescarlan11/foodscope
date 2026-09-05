import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type { AppConfig } from './config.js';
import type { BillingProvider, DemoUser, Repository } from './types.js';

function integrationIdentifier(attemptId: string) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const digest = createHash('sha256').update(attemptId).digest();
  return `foodscope_${Array.from(digest.subarray(0, 8), (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: Repository,
    stripeClient?: Stripe,
  ) {
    if (!config.stripeSecretKey) throw new Error('Stripe is not configured');
    this.stripe = stripeClient ?? new Stripe(config.stripeSecretKey);
  }

  async createCheckout(user: DemoUser) {
    if (!this.config.stripePriceId) throw new Error('Stripe price is not configured');

    const attempt = await this.repository.getOrCreateCheckoutAttempt(user.id);
    if (attempt.sessionUrl) return { url: attempt.sessionUrl };

    let customerId = user.stripeCustomerId;
    if (!customerId) {
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
    if (!session.url) throw new Error('Stripe did not return a Checkout URL');
    await this.repository.completeCheckoutAttempt(user.id, attempt.id, {
      id: session.id,
      url: session.url,
      expiresAt: new Date(session.expires_at * 1000),
    });
    return { url: session.url };
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
  if (!config.stripeSecretKey) return null;
  return new StripeBillingProvider(config, repository);
}
