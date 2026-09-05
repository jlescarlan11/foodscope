import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type { AppConfig } from './config.js';
import { CheckoutUnavailableError } from './errors.js';
import {
  isStripePriceId,
  isStripeTestSecretKey,
  isStripeWebhookSecret,
} from './stripe-config.js';
import { isMonthlyTestPrice } from './stripe-price.js';
import type { BillingProvider, DemoUser, Repository } from './types.js';

const STRIPE_REQUEST_TIMEOUT_MS = 5_000;
const MINIMUM_CHECKOUT_EXPIRY_MS = 30 * 60 * 1000;
const TERMINAL_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
  'canceled',
  'incomplete_expired',
]);

function integrationIdentifier(attemptId: string) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const digest = createHash('sha256').update(attemptId).digest();
  return `foodscope_${Array.from(digest.subarray(0, 8), (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

function replacementCustomerIdempotencyKey(customerId: string) {
  const digest = createHash('sha256').update(customerId).digest('hex');
  return `foodscope-demo-customer-replacement-${digest}`;
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

function isStaleCheckoutExpiryError(error: unknown, expiresAt: Date) {
  return error instanceof Stripe.errors.StripeInvalidRequestError &&
    error.param === 'expires_at' &&
    expiresAt.getTime() <= Date.now() + MINIMUM_CHECKOUT_EXPIRY_MS;
}

export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe;
  private readonly checkoutRequests = new Map<string, Promise<{ url: string }>>();
  private configuredPriceValidation: Promise<void> | null = null;
  private configuredPriceError: Error | null = null;
  private configuredPriceValidated = false;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: Repository,
    stripeClient?: Stripe,
  ) {
    if (!config.stripeSecretKey) throw new Error('Stripe is not configured');
    if (!isStripeTestSecretKey(config.stripeSecretKey)) {
      throw new Error('Foodscope only supports Stripe test mode');
    }
    this.stripe = stripeClient ?? new Stripe(config.stripeSecretKey, {
      timeout: STRIPE_REQUEST_TIMEOUT_MS,
      maxNetworkRetries: 1,
    });
  }

  createCheckout(user: DemoUser) {
    const pending = this.checkoutRequests.get(user.id);
    if (pending) return pending;
    const request = this.createCheckoutOnce(user).finally(() => {
      if (this.checkoutRequests.get(user.id) === request) this.checkoutRequests.delete(user.id);
    });
    this.checkoutRequests.set(user.id, request);
    return request;
  }

  private validateConfiguredPrice() {
    if (this.configuredPriceValidated) return Promise.resolve();
    if (this.configuredPriceError) return Promise.reject(this.configuredPriceError);
    if (this.configuredPriceValidation) return this.configuredPriceValidation;
    if (!this.config.stripePriceId) return Promise.reject(new Error('Stripe price is not configured'));

    const request = this.stripe.prices.retrieve(this.config.stripePriceId).then((price) => {
      if (!isMonthlyTestPrice(price, this.config.stripePriceId!)) {
        this.configuredPriceError = new Error(
          'Stripe Price does not match the Foodscope monthly plan',
        );
        throw this.configuredPriceError;
      }
      if (price.active !== true) {
        this.configuredPriceError = new Error(
          'Stripe Price is unavailable for new Foodscope purchases',
        );
        throw this.configuredPriceError;
      }
      this.configuredPriceValidated = true;
    }).finally(() => {
      if (this.configuredPriceValidation === request) this.configuredPriceValidation = null;
    });
    this.configuredPriceValidation = request;
    return request;
  }

  private async createCheckoutOnce(
    user: DemoUser,
    canRecoverStaleExpiry = true,
    canRecoverDeletedCustomer = true,
  ): Promise<{ url: string }> {
    if (!this.config.stripePriceId) throw new Error('Stripe price is not configured');

    const attempt = await this.repository.getOrCreateCheckoutAttempt(user.id);
    if (attempt.priceId !== this.config.stripePriceId) throw new CheckoutUnavailableError();
    await this.validateConfiguredPrice();
    const storedSessionUrl = safeCheckoutUrl(attempt.sessionUrl);

    let customerId = attempt.customerId;
    if (customerId) {
      const customer = await this.stripe.customers.retrieve(customerId);
      if ('deleted' in customer && customer.deleted === true) {
        if (!canRecoverDeletedCustomer) throw new CheckoutUnavailableError();
        const replacement = await this.stripe.customers.create({
          email: user.email,
          metadata: { demoUserId: user.id },
        }, { idempotencyKey: replacementCustomerIdempotencyKey(customerId) });
        customerId = await this.repository.replaceStripeCustomer(
          user.id,
          customerId,
          attempt.id,
          replacement.id,
        );
        return this.createCheckoutOnce(
          user,
          canRecoverStaleExpiry,
          false,
        );
      }
      if (storedSessionUrl) return { url: storedSessionUrl };
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
      if (storedSessionUrl) throw new CheckoutUnavailableError();
      const customer = await this.stripe.customers.create({
        email: user.email,
        metadata: { demoUserId: user.id },
      }, { idempotencyKey: 'foodscope-demo-customer-v1' });
      customerId = customer.id;
      await this.repository.setStripeCustomer(user.id, customerId);
    }
    if (storedSessionUrl) return { url: storedSessionUrl };

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create({
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
    } catch (error) {
      if (!canRecoverStaleExpiry || !isStaleCheckoutExpiryError(error, attempt.expiresAt)) {
        throw error;
      }
      await this.repository.releaseCheckoutAttempt(user.id, attempt.id);
      return this.createCheckoutOnce(
        user,
        false,
        canRecoverDeletedCustomer,
      );
    }
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
  if (!isStripeTestSecretKey(config.stripeSecretKey!)) {
    throw new Error('Foodscope only supports Stripe test mode');
  }
  if (!isStripeWebhookSecret(config.stripeWebhookSecret!) || !isStripePriceId(config.stripePriceId!)) {
    throw new Error('Stripe configuration contains an invalid webhook secret or Price ID');
  }
  return new StripeBillingProvider(config, repository);
}
