import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type { AppConfig } from './config.js';
import { CheckoutUnavailableError } from './errors.js';
import {
  isStripePriceId,
  isStripeOpaqueId,
  isStripeTestSecretKey,
  isStripeWebhookSecret,
} from './stripe-config.js';
import { isMonthlyTestPrice } from './stripe-price.js';
import type { BillingProvider, DemoUser, Repository } from './types.js';

const STRIPE_REQUEST_TIMEOUT_MS = 5_000;
const MINIMUM_CHECKOUT_EXPIRY_MS = 30 * 60 * 1000;
const TERMINAL_SUBSCRIPTION_STATUSES = new Set<string>([
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

function expandableCustomerId(value: unknown) {
  if (isStripeOpaqueId(value)) return value;
  if (
    typeof value === 'object' && value !== null && 'id' in value &&
    'object' in value && value.object === 'customer' &&
    isStripeOpaqueId(value.id)
  ) return value.id;
  return null;
}

function createdCustomerId(value: unknown, demoUserId: string) {
  if (typeof value !== 'object' || value === null) return null;
  const customer = value as Record<string, unknown>;
  return isStripeOpaqueId(customer.id) &&
    customer.object === 'customer' &&
    customer.livemode === false &&
    typeof customer.metadata === 'object' && customer.metadata !== null &&
    (customer.metadata as Record<string, unknown>).demoUserId === demoUserId
    ? customer.id
    : null;
}

function hasOnlyTerminalSubscriptions(value: unknown, expectedCustomerId: string) {
  if (typeof value !== 'object' || value === null) return false;
  const page = value as Record<string, unknown>;
  return page.has_more === false &&
    Array.isArray(page.data) &&
    page.data.every((subscription) => {
      if (typeof subscription !== 'object' || subscription === null) return false;
      const item = subscription as Record<string, unknown>;
      return isStripeOpaqueId(item.id) &&
        item.object === 'subscription' &&
        item.livemode === false &&
        expandableCustomerId(item.customer) === expectedCustomerId &&
        typeof item.status === 'string' && TERMINAL_SUBSCRIPTION_STATUSES.has(item.status);
    });
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
      if (customer.object !== 'customer') throw new CheckoutUnavailableError();
      if ('deleted' in customer && customer.deleted === true) {
        if (!canRecoverDeletedCustomer) throw new CheckoutUnavailableError();
        const replacement = await this.stripe.customers.create({
          email: user.email,
          metadata: { demoUserId: user.id },
        }, { idempotencyKey: replacementCustomerIdempotencyKey(customerId) });
        const replacementCustomerId = createdCustomerId(replacement, user.id);
        if (!replacementCustomerId) throw new Error('Stripe did not return a valid Stripe Customer');
        customerId = await this.repository.replaceStripeCustomer(
          user.id,
          customerId,
          attempt.id,
          replacementCustomerId,
        );
        return this.createCheckoutOnce(
          user,
          canRecoverStaleExpiry,
          false,
        );
      }
      if (
        customer.livemode !== false || customer.metadata?.demoUserId !== user.id
      ) {
        throw new CheckoutUnavailableError();
      }
      if (storedSessionUrl) return { url: storedSessionUrl };
      const subscriptions = await this.stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      });
      if (!hasOnlyTerminalSubscriptions(subscriptions, customerId)) {
        throw new CheckoutUnavailableError();
      }
    } else {
      if (storedSessionUrl) throw new CheckoutUnavailableError();
      const customer = await this.stripe.customers.create({
        email: user.email,
        metadata: { demoUserId: user.id },
      }, { idempotencyKey: 'foodscope-demo-customer-v1' });
      customerId = createdCustomerId(customer, user.id);
      if (!customerId) throw new Error('Stripe did not return a valid Stripe Customer');
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
    if (
      !isStripeOpaqueId(session.id) ||
      session.object !== 'checkout.session' ||
      session.livemode !== false ||
      session.mode !== 'subscription' ||
      session.status !== 'open' ||
      expandableCustomerId(session.customer) !== customerId ||
      session.metadata?.demoUserId !== user.id ||
      !Number.isSafeInteger(session.expires_at) ||
      session.expires_at !== Math.floor(attempt.expiresAt.getTime() / 1000)
    ) {
      throw new Error('Stripe did not return a valid Checkout Session');
    }
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
