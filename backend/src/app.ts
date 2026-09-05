import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type Stripe from 'stripe';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { isActiveSubscription, NUTRITION_RULES, SUPPORTED_LOCALES } from './constants.js';
import { ProductProviderRateLimitError } from './open-food-facts.js';
import type { BillingProvider, Nutrition, ProductProvider, Repository } from './types.js';

export type AppDependencies = {
  config: AppConfig;
  repository: Repository;
  products: ProductProvider;
  billing: BillingProvider | null;
};

const searchSchema = z.object({
  q: z.string().trim().min(1).max(120),
  lang: z.enum(SUPPORTED_LOCALES).default('en'),
});

const relevantStripeEventTypes = new Set<Stripe.Event.Type>([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

function publicNutrition(value: Nutrition | undefined) {
  if (!value) return undefined;
  const nutrition: Nutrition = {};
  for (const key of Object.keys(NUTRITION_RULES) as Array<keyof Nutrition>) {
    const nutrient = value[key];
    const rule = NUTRITION_RULES[key];
    if (
      nutrient &&
      Number.isFinite(nutrient.value) &&
      nutrient.value >= 0 &&
      nutrient.value <= rule.maximum &&
      nutrient.unit === rule.unit
    ) {
      nutrition[key] = { value: nutrient.value, unit: nutrient.unit };
    }
  }
  return Object.keys(nutrition).length ? nutrition : undefined;
}

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);

export function createApp(deps: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: deps.config.frontendUrl }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.post(
    '/api/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    asyncRoute(async (req, res) => {
      const signature = req.header('stripe-signature');
      if (!signature || !Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: 'Invalid webhook request' });
        return;
      }
      if (!deps.billing) {
        res.status(503).json({ error: 'Stripe is not configured' });
        return;
      }
      let event;
      try {
        event = deps.billing.constructEvent(req.body, signature);
      } catch {
        res.status(400).json({ error: 'Invalid webhook signature' });
        return;
      }
      if (!relevantStripeEventTypes.has(event.type)) {
        res.json({ received: true });
        return;
      }
      if (await deps.repository.isStripeEventProcessed(event.id)) {
        res.json({ received: true });
        return;
      }
      const retrieveSubscription = event.type.startsWith('customer.subscription.')
        ? (subscriptionId: string) => deps.billing!.retrieveSubscription(subscriptionId)
        : undefined;
      await deps.repository.processStripeEvent(event, retrieveSubscription);
      res.json({ received: true });
    }),
  );

  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get(
    '/api/user',
    asyncRoute(async (_req, res) => {
      const user = await deps.repository.getDemoUser();
      if (!user) {
        res.status(503).json({ error: 'Demo user is not initialized' });
        return;
      }
      res.json({
        email: user.email,
        subscriptionStatus: user.subscriptionStatus,
        subscriptionCurrentPeriodEnd: user.subscriptionCurrentPeriodEnd,
        nutritionAccess: isActiveSubscription(user.subscriptionStatus),
        billingAvailable: deps.billing !== null,
      });
    }),
  );

  app.get(
    '/api/products/search',
    asyncRoute(async (req, res) => {
      const parsed = searchSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Enter a search term and choose a supported locale' });
        return;
      }
      const user = await deps.repository.getDemoUser();
      if (!user) {
        res.status(503).json({ error: 'Demo user is not initialized' });
        return;
      }

      let results;
      const controller = new AbortController();
      req.once('aborted', () => controller.abort());
      try {
        results = await deps.products.search(parsed.data.q, parsed.data.lang, controller.signal);
      } catch (error) {
        if (error instanceof ProductProviderRateLimitError) {
          if (error.retryAfterSeconds !== undefined) {
            res.set('Retry-After', String(error.retryAfterSeconds));
          }
          res.status(503).json({ error: 'Product search is temporarily unavailable' });
          return;
        }
        res.status(502).json({ error: 'Product search is temporarily unavailable' });
        return;
      }

      const publicResults = results.map((product) => ({
        product,
        nutrition: publicNutrition(product.nutrition),
      }));
      const hasNutrition = publicResults.some(({ nutrition }) => nutrition !== undefined);
      const currentUser = hasNutrition ? await deps.repository.getDemoUser() : user;
      const unlocked = currentUser ? isActiveSubscription(currentUser.subscriptionStatus) : false;
      const products = publicResults.map(({ product, nutrition }) => {
        if (unlocked) return {
          id: product.id,
          name: product.name,
          brand: product.brand,
          image: product.image,
          ...(nutrition ? { nutrition } : {}),
          nutritionLocked: false,
        };
        return {
          id: product.id,
          name: product.name,
          brand: product.brand,
          image: product.image,
          nutritionLocked: nutrition !== undefined,
        };
      });
      await deps.repository.saveSearch(user.id, parsed.data.q, parsed.data.lang);
      res.json({ products });
    }),
  );

  app.get(
    '/api/searches/recent',
    asyncRoute(async (_req, res) => {
      const user = await deps.repository.getDemoUser();
      if (!user) {
        res.status(503).json({ error: 'Demo user is not initialized' });
        return;
      }
      const searches = await deps.repository.getRecentSearches(user.id, 8);
      res.json({ searches });
    }),
  );

  app.post(
    '/api/billing/checkout-session',
    asyncRoute(async (_req, res) => {
      if (!deps.billing) {
        res.status(503).json({ error: 'Stripe is not configured' });
        return;
      }
      const user = await deps.repository.getDemoUser();
      if (!user) {
        res.status(503).json({ error: 'Demo user is not initialized' });
        return;
      }
      if (isActiveSubscription(user.subscriptionStatus)) {
        res.status(409).json({ error: 'The demo user already has nutrition access' });
        return;
      }
      try {
        res.status(201).json(await deps.billing.createCheckout(user));
      } catch {
        res.status(502).json({ error: 'Unable to start Checkout' });
      }
    }),
  );

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    void next;
    if (typeof error === 'object' && error !== null && 'type' in error) {
      if (error.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'Invalid JSON request' });
        return;
      }
      if (error.type === 'entity.too.large') {
        res.status(413).json({ error: 'Request body is too large' });
        return;
      }
    }
    console.error('Unexpected request failure', { method: req.method, path: req.path });
    res.status(500).json({ error: 'Unexpected server error' });
  });
  return app;
}
