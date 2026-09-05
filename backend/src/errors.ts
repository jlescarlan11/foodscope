export class CheckoutUnavailableError extends Error {
  constructor() {
    super('Checkout is unavailable for the current subscription state');
  }
}
