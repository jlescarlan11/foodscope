export class CheckoutUnavailableError extends Error {
  constructor() {
    super('Checkout is unavailable for the current subscription state');
  }
}

export class CheckoutRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Checkout request limit reached');
  }
}

export class SubscriptionUnavailableError extends Error {
  constructor() {
    super('Subscription management is unavailable for the current subscription state');
  }
}
