import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type Stripe from 'stripe';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { canStartCheckout, hasNutritionAccess, NUTRITION_RULES, SUPPORTED_LOCALES } from './constants.js';
import { ProductProviderRateLimitError } from './open-food-facts.js';
import { CheckoutUnavailableError } from './errors.js';
import type { BillingProvider, Nutrition, ProductProvider, Repository } from './types.js';

export type AppDependencies = {
  config: AppConfig;
  repository: Repository;
  products: ProductProvider;
  billing: BillingProvider | null;
};

const searchSchema = z.object({
  requestId: z.string().uuid(),
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
  const requireFrontendOrigin = (req: Request, res: Response, next: NextFunction) => {
    if (req.header('origin') !== deps.config.frontendUrl) {
      res.status(403).json({ error: 'Request is only available from the Foodscope frontend' });
      return;
    }
    next();
  };
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: deps.config.frontendUrl }));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.post(
    '/api/webhooks/stripe',
    (req, res, next) => {
      if (!req.header('stripe-signature')) {
        res.status(400).json({ error: 'Invalid webhook request' });
        return;
      }
      if (!deps.billing) {
        res.status(503).json({ error: 'Stripe is not configured' });
        return;
      }
      next();
    },
    express.raw({ type: 'application/json' }),
    asyncRoute(async (req, res) => {
      const signature = req.header('stripe-signature');
      if (!signature || !Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: 'Invalid webhook request' });
        return;
      }
      let event;
      try {
        event = deps.billing!.constructEvent(req.body, signature);
      } catch {
        res.status(400).json({ error: 'Invalid webhook signature' });
        return;
      }
      if (!relevantStripeEventTypes.has(event.type)) {
        res.json({ received: true });
        return;
      }
      if (event.livemode !== false) {
        res.json({ received: true });
        return;
      }
      if (typeof event.id !== 'string' || event.id.length === 0 || Array.from(event.id).length > 255) {
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

  app.post(['/api/products/search', '/api/billing/checkout-session'], requireFrontendOrigin);
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
        nutritionAccess: hasNutritionAccess(
          user.subscriptionStatus,
          user.subscriptionCurrentPeriodEnd,
        ),
        billingAvailable: deps.billing !== null,
        checkoutAvailable: deps.billing !== null && canStartCheckout(user.subscriptionStatus),
      });
    }),
  );

  app.post(
    '/api/products/search',
    asyncRoute(async (req, res) => {
      const parsed = searchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Enter a search term and choose a supported locale' });
        return;
      }
      const controller = new AbortController();
      req.once('aborted', () => controller.abort());
      res.once('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const user = await deps.repository.getDemoUser();
      if (controller.signal.aborted) return;
      if (!user) {
        res.status(503).json({ error: 'Demo user is not initialized' });
        return;
      }

      let results;
      try {
        results = await deps.products.search(parsed.data.q, parsed.data.lang, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ProductProviderRateLimitError) {
          if (error.retryAfterSeconds !== undefined) {
            res.set('Retry-After', String(error.retryAfterSeconds));
          }
          res.status(503).json({ error: 'Product search is temporarily unavailable' });
          return;
        }
        console.error('Product search provider failed');
        res.status(502).json({ error: 'Product search is temporarily unavailable' });
        return;
      }
      if (controller.signal.aborted) return;

      const publicResults = results.map((product) => ({
        product,
        nutrition: publicNutrition(product.nutrition),
      }));
      const hasNutrition = publicResults.some(({ nutrition }) => nutrition !== undefined);
      const currentUser = hasNutrition ? await deps.repository.getDemoUser() : user;
      if (controller.signal.aborted) return;
      const unlocked = currentUser ? hasNutritionAccess(
        currentUser.subscriptionStatus,
        currentUser.subscriptionCurrentPeriodEnd,
      ) : false;
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
      await deps.repository.saveSearch(
        user.id,
        parsed.data.requestId,
        parsed.data.q,
        parsed.data.lang,
      );
      res.json({ products });
    }),
  );

  app.get(
    '/api/searches/recent',
    asyncRoute(async (_req, res) => {
      let responseClosed = false;
      res.once('close', () => {
        if (!res.writableEnded) responseClosed = true;
      });
      const user = await deps.repository.getDemoUser();
      if (responseClosed) return;
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
      let responseClosed = false;
      res.once('close', () => {
        if (!res.writableEnded) responseClosed = true;
      });
      const user = await deps.repository.getDemoUser();
      if (responseClosed) return;
      if (!user) {
        res.status(503).json({ error: 'Demo user is not initialized' });
        return;
      }
      if (!canStartCheckout(user.subscriptionStatus)) {
        res.status(409).json({ error: 'Checkout is unavailable for the current subscription state' });
        return;
      }
      try {
        res.status(201).json(await deps.billing.createCheckout(user));
      } catch (error) {
        if (error instanceof CheckoutUnavailableError) {
          res.status(409).json({ error: 'Checkout is unavailable for the current subscription state' });
          return;
        }
        console.error('Checkout provider failed');
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
