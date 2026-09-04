import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import type { AppConfig } from './config.js';
import type { BillingProvider, DemoUser, Repository } from './types.js';

function integrationIdentifier() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  return `foodscope_${Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe;

  constructor(private readonly config: AppConfig, private readonly repository: Repository) {
    if (!config.stripeSecretKey) throw new Error('Stripe is not configured');
    this.stripe = new Stripe(config.stripeSecretKey);
  }

  async createCheckout(user: DemoUser) {
    if (!this.config.stripePriceId) throw new Error('Stripe price is not configured');

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email: user.email,
        metadata: { demoUserId: user.id },
      });
      customerId = customer.id;
      await this.repository.setStripeCustomer(user.id, customerId);
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: this.config.stripePriceId, quantity: 1 }],
      metadata: { demoUserId: user.id },
      subscription_data: { metadata: { demoUserId: user.id } },
      success_url: `${this.config.frontendUrl}/?checkout=success`,
      cancel_url: `${this.config.frontendUrl}/?checkout=cancelled`,
      integration_identifier: integrationIdentifier(),
    });
    if (!session.url) throw new Error('Stripe did not return a Checkout URL');
    return { url: session.url };
  }

  constructEvent(body: Buffer, signature: string) {
    if (!this.config.stripeWebhookSecret) throw new Error('Stripe webhook is not configured');
    return this.stripe.webhooks.constructEvent(body, signature, this.config.stripeWebhookSecret);
  }
}

export function createBillingProvider(config: AppConfig, repository: Repository) {
  if (!config.stripeSecretKey) return null;
  return new StripeBillingProvider(config, repository);
}
