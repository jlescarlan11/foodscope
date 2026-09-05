function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMonthlyTestPrice(value: unknown, expectedPriceId: string) {
  if (!isRecord(value) || !isRecord(value.recurring)) return false;
  return (
    value.id === expectedPriceId &&
    value.livemode === false &&
    value.type === 'recurring' &&
    value.recurring.interval === 'month' &&
    value.recurring.interval_count === 1
  );
}
