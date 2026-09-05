import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type Stripe from 'stripe';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { isActiveSubscription, SUPPORTED_LOCALES } from './constants.js';
import { ProductProviderRateLimitError } from './open-food-facts.js';
import type { BillingProvider, ProductProvider, Repository } from './types.js';

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

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);

export function createApp(deps: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: deps.config.frontendUrl }));

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
      const subscriptionEvent =
        event.type === 'customer.subscription.created' ||
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted';
      const currentSubscription = subscriptionEvent
        ? await deps.billing.retrieveSubscription((event.data.object as Stripe.Subscription).id)
        : undefined;
      await deps.repository.processStripeEvent(event, currentSubscription);
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

      await deps.repository.saveSearch(user.id, parsed.data.q, parsed.data.lang);
      const currentUser = await deps.repository.getDemoUser();
      const unlocked = currentUser ? isActiveSubscription(currentUser.subscriptionStatus) : false;
      const products = results.map((product) => {
        if (unlocked) return { ...product, nutritionLocked: false };
        return {
          id: product.id,
          name: product.name,
          brand: product.brand,
          image: product.image,
          nutritionLocked: true,
        };
      });
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
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    void next;
    console.error(error instanceof Error ? error.message : 'Unexpected request failure');
    res.status(500).json({ error: 'Unexpected server error' });
  });
  return app;
}
