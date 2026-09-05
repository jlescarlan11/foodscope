export const isStripeTestSecretKey = (value: string) => /^(?:sk|rk)_test_\S+$/.test(value);
export const isStripeWebhookSecret = (value: string) => /^whsec_\S+$/.test(value);
export const isStripePriceId = (value: string) => /^price_\S+$/.test(value);
export const isStripeOpaqueId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Array.from(value).length <= 255;
