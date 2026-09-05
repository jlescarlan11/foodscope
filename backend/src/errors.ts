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
