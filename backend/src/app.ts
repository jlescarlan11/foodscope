import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type Stripe from 'stripe';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import {
  canStartCheckout,
  hasNutritionAccess,
  isUsableText,
  NUTRITION_RULES,
  SUPPORTED_LOCALES,
} from './constants.js';
import { ProductProviderRateLimitError } from './open-food-facts.js';
import {
  CheckoutRateLimitError,
  CheckoutUnavailableError,
  SubscriptionUnavailableError,
} from './errors.js';
import type { BillingProvider, DemoUserState, Nutrition, ProductProvider, Repository } from './types.js';

export type AppDependencies = {
  config: AppConfig;
  repository: Repository;
  products: ProductProvider;
  billing: BillingProvider | null;
};

const searchSchema = z.object({
  requestId: z.string().uuid(),
  q: z.string().trim().min(1).max(120).refine(isUsableText),
  lang: z.enum(SUPPORTED_LOCALES),
  page: z.number().int().min(1).max(100).default(1),
});

const PRODUCT_PAGE_SIZE = 4;

const subscriptionCancellationSchema = z.object({
  requestId: z.string().uuid(),
  cancelAtPeriodEnd: z.boolean(),
});

const relevantStripeEventTypes = new Set<Stripe.Event.Type>([
  'checkout.session.completed',
  'checkout.session.expired',
  'customer.deleted',
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

function publicAccount(user: DemoUserState, billingAvailable: boolean) {
  const nutritionAccess = hasNutritionAccess(
    user.subscriptionStatus,
    user.subscriptionCurrentPeriodEnd,
  );
  const subscriptionManagementAvailable = Boolean(
    billingAvailable && nutritionAccess && user.stripeSubscriptionId,
  );
  return {
    nutritionAccess,
    billingAvailable,
    checkoutAvailable: billingAvailable && canStartCheckout(user.subscriptionStatus),
    subscriptionManagementAvailable,
    cancellationScheduled: subscriptionManagementAvailable &&
      user.subscriptionCancelAtPeriodEnd,
    currentPeriodEnd: nutritionAccess && user.subscriptionCurrentPeriodEnd
      ? user.subscriptionCurrentPeriodEnd.toISOString()
      : null,
  };
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
  app.use(cors({
    origin: deps.config.frontendUrl,
    exposedHeaders: ['Retry-After'],
  }));
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
      const retrieveSubscription = event.type.startsWith('customer.subscription.')
        ? (subscriptionId: string) => deps.billing!.retrieveSubscription(subscriptionId)
        : undefined;
      await deps.repository.processStripeEvent(event, retrieveSubscription);
      res.json({ received: true });
    }),
  );

  app.post([
    '/api/products/search',
    '/api/billing/checkout-session',
    '/api/billing/subscription-cancellation',
  ], requireFrontendOrigin);
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
      res.json(publicAccount(user, deps.billing !== null));
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
        results = await deps.products.search(
          parsed.data.q,
          parsed.data.lang,
          controller.signal,
          parsed.data.page,
          PRODUCT_PAGE_SIZE,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ProductProviderRateLimitError) {
          // Some upstream 429/503 responses omit Retry-After. Keep the API contract
          // actionable so clients can distinguish backpressure from a generic failure.
          const retryAfterSeconds = error.retryAfterSeconds ?? 60;
          res.set('Retry-After', String(retryAfterSeconds));
          res.status(503).json({ error: 'Product search is temporarily unavailable' });
          return;
        }
        console.error('Product search provider failed');
        res.status(502).json({ error: 'Product search is temporarily unavailable' });
        return;
      }
      if (controller.signal.aborted) return;

      const publicResults = results.products.map((product) => ({
        product,
        nutrition: publicNutrition(product.nutrition),
      }));
      let currentUser = await deps.repository.getDemoUser();
      if (controller.signal.aborted) return;
      let unlocked = currentUser ? hasNutritionAccess(
        currentUser.subscriptionStatus,
        currentUser.subscriptionCurrentPeriodEnd,
      ) : false;
      if (parsed.data.page === 1) {
        await deps.repository.saveSearch(
          user.id,
          parsed.data.requestId,
          parsed.data.q,
          parsed.data.lang,
        );
      }
      if (controller.signal.aborted) return;
      if (unlocked && publicResults.some(({ nutrition }) => nutrition !== undefined)) {
        currentUser = await deps.repository.getDemoUser();
        if (controller.signal.aborted) return;
        unlocked = currentUser ? hasNutritionAccess(
          currentUser.subscriptionStatus,
          currentUser.subscriptionCurrentPeriodEnd,
        ) : false;
      }
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
      res.json({
        products,
        account: currentUser ? publicAccount(currentUser, deps.billing !== null) : null,
        hasMore: results.hasMore,
        nextPage: results.hasMore ? parsed.data.page + 1 : null,
      });
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
      res.json({
        searches: searches.flatMap(({ query, locale }) =>
          query.trim() && Array.from(query).length <= 120 &&
            isUsableText(query) &&
            SUPPORTED_LOCALES.includes(locale as (typeof SUPPORTED_LOCALES)[number])
            ? [{ query, locale }]
            : []),
      });
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
      const user = await deps.repository.getDemoUserForCheckout();
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
        if (error instanceof CheckoutRateLimitError) {
          res.set('Retry-After', String(error.retryAfterSeconds));
          res.status(429).json({ error: 'Too many Checkout attempts' });
          return;
        }
        if (error instanceof CheckoutUnavailableError) {
          res.status(409).json({ error: 'Checkout is unavailable for the current subscription state' });
          return;
        }
        console.error('Checkout provider failed');
        res.status(502).json({ error: 'Unable to start Checkout' });
      }
    }),
  );

  app.post(
    '/api/billing/subscription-cancellation',
    asyncRoute(async (req, res) => {
      const parsed = subscriptionCancellationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'A valid subscription change request is required' });
        return;
      }
      if (!deps.billing) {
        res.status(503).json({ error: 'Stripe is not configured' });
        return;
      }
      const user = await deps.repository.getDemoUserForCheckout();
      if (!user) {
        res.status(503).json({ error: 'Demo user is not initialized' });
        return;
      }
      try {
        await deps.billing.updateSubscriptionCancellation(
          user,
          parsed.data.cancelAtPeriodEnd,
          parsed.data.requestId,
        );
      } catch (error) {
        if (error instanceof SubscriptionUnavailableError) {
          res.status(409).json({ error: 'Subscription management is unavailable' });
          return;
        }
        console.error('Subscription management provider failed');
        res.status(502).json({ error: 'Unable to update the subscription' });
        return;
      }
      const currentUser = await deps.repository.getDemoUser();
      if (!currentUser) {
        res.status(503).json({ error: 'Demo user is not initialized' });
        return;
      }
      res.json(publicAccount(currentUser, true));
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
