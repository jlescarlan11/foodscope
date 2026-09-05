export class NutritionAccessAlreadyActiveError extends Error {
  constructor() {
    super('The demo user already has nutrition access');
  }
}
