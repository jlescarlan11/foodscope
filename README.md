# Foodscope

Foodscope is a small full-stack packaged-food search application. It searches Open Food Facts through an Express API, remembers searches for one deterministic demo user, supports four UI languages, and unlocks normalized nutrition data after a Stripe test subscription is confirmed by signed webhooks.

## Tech stack

- Frontend: TypeScript, Next.js App Router, React, Tailwind CSS
- Backend: TypeScript, Express, Zod, Prisma
- Data: MySQL 8.4 with a committed migration and deterministic seed
- External services: Open Food Facts and Stripe Billing/Checkout (test mode)
- Tests: Vitest, Supertest, React Testing Library

## Architecture

```text
Browser
  ↓
Next.js frontend
  ↓
Express API
  ├── Open Food Facts (product search only)
  ├── Stripe Checkout + verified webhooks
  └── Prisma → MySQL (demo user, subscription state, recent searches)
```

The browser never calls Open Food Facts or Stripe APIs directly. Express validates the locale/query, normalizes the small Open Food Facts response, loads subscription state from MySQL, and removes the complete `nutrition` property unless the stored status is `active` or `trialing` with a valid future billing-period end. Missing, unrecognized, or elapsed subscription data fails closed; unknown Stripe status values are durably normalized to `unknown`. API responses use `Cache-Control: no-store` so a prior entitled response cannot survive revocation in a browser or intermediary cache. Every returned nutrient carries its explicit per-100-g value and unit. Because Open Food Facts' legacy `_100g` fields represent 100 ml for liquids, Foodscope exposes them only when the provider explicitly identifies the product quantity unit as grams; a volume or missing basis leaves nutrition unavailable.
Impossible upstream values are treated as unavailable: mass nutrients cannot exceed 100 g per 100 g,
and energy is conservatively capped at 1,000 kcal per 100 g.

## Prerequisites

- Node.js 24 LTS
- npm 10 or newer
- Docker with Compose
- Optional for the subscription walkthrough: a Stripe account in test mode and the Stripe CLI

## Local setup

```bash
git clone <repository-url>
cd foodscope
cp .env.example backend/.env
cp .env.example frontend/.env.local
# Replace OPEN_FOOD_FACTS_USER_AGENT in backend/.env with a real contact.
docker compose up -d
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://localhost:3000>. The API runs at <http://localhost:4000>. MySQL is published only on the workstation loopback interface and may take a few seconds to become healthy after its first start; `docker compose ps` shows its status.

## Environment variables

The committed `.env.example` contains fake placeholders only. Replace
`OPEN_FOOD_FACTS_USER_AGENT` with an application/version and a monitored contact before starting
the backend; the placeholder is rejected so anonymous traffic cannot be sent accidentally.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Backend/Prisma | Local MySQL connection |
| `PORT` | Backend | Express port (default `4000`) |
| `HOST` | Backend | Listen address; defaults to loopback locally and `0.0.0.0` in production |
| `FRONTEND_URL` | Backend | One absolute HTTP(S) origin used for CORS and Checkout return URLs; required in production |
| `NEXT_PUBLIC_API_URL` | Frontend | Absolute HTTP(S) origin of the Express API; required for production builds |
| `STRIPE_SECRET_KEY` | Backend | Stripe test key; a least-privilege restricted key is preferred where supported |
| `STRIPE_WEBHOOK_SECRET` | Backend | Signing secret from the Stripe webhook endpoint/CLI |
| `STRIPE_PRICE_ID` | Backend | Recurring monthly Price ID |
| `OPEN_FOOD_FACTS_USER_AGENT` | Backend | Identifiable User-Agent required for responsible API access |

The backend and frontend receive separate local env copies because workspace tools run from their package directories. Deployed environments should set variables through the host's protected environment configuration and expose only `NEXT_PUBLIC_API_URL` to the browser. Non-loopback production frontend/API origins must use HTTPS; HTTP remains available for local verification. Missing, structurally invalid, or unreachable MySQL configuration fails before the API listens without printing its value. Billing is disabled when all Stripe values are absent; partial or structurally malformed configuration fails startup before provider work. Stripe accepts test-mode secret or restricted keys and refuses either live-mode prefix; verified live-mode or malformed-mode webhook events are acknowledged without processing. Use a least-privilege restricted test key where possible.

## Database

`User` stores the fixed demo account and Stripe subscription state. `RecentSearch` belongs to that user and is indexed by user/time. New search operations carry a unique request ID so retrying after a lost response cannot append the same history entry twice; the nullable column preserves existing rows. `StripeWebhookEvent` stores Stripe event IDs so repeated webhook delivery is harmless. API startup and the optional seed create the demo user only when missing and preserve all existing subscription, webhook, and search data.

```bash
npm run db:generate   # generate Prisma Client
npm run db:migrate    # apply committed migrations
npm run db:seed       # create the one fixed user if it does not exist
```

The deterministic ID is `00000000-0000-4000-8000-000000000001`; there is intentionally no API that accepts a user ID.

## Development

```bash
npm run dev                 # frontend and backend together
npm run dev -w frontend     # Next.js only
npm run dev -w backend      # Express only
```

## Stripe test setup

1. In Stripe test mode, create one Product and a recurring monthly Price.
2. Put its `price_...` ID and a test-mode backend key in `backend/.env`. Use a restricted test key with only the permissions needed to create/read Customers and Checkout Sessions and read/list Subscriptions when possible.
3. Forward signed events locally:

   ```bash
   stripe listen --forward-to localhost:4000/api/webhooks/stripe
   ```

4. Copy the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`, restart the API, select **Unlock nutrition**, and use Stripe's standard test card `4242 4242 4242 4242` with any future expiry and CVC.

Checkout uses `mode: subscription`, the configured recurring Price, a reused Stripe Customer, and demo-user metadata on both the Session and Subscription. Checkout creation requires the browser's `Origin` to exactly match `FRONTEND_URL`, preventing another site from triggering Stripe work through a cross-site POST. A durable one-hour attempt and Stripe idempotency keys make concurrent or retried requests reuse one Customer and open Checkout Session while preserving Stripe's required minimum expiry window through preflight work. Before replacing an expired attempt, Foodscope refuses to create another Session while that Customer has a non-terminal subscription. No payment-method list is hard-coded, so Stripe's test Dashboard settings control eligible methods. The handler verifies the raw body before processing `checkout.session.completed` and `customer.subscription.created|updated|deleted`. Subscription events lock the mapped demo-user row and then retrieve current Stripe state; only the stored Subscription ID or a matching durable Checkout attempt can establish authority, so concurrent, out-of-order, or unrelated subscriptions cannot change access. Stripe identifiers use 255-character, case-sensitive storage as required for opaque IDs; Event IDs make retries idempotent. Bounded Stripe/transaction timeouts turn provider failures into safe webhook retries. The backend Stripe key therefore needs read/list access to Subscriptions in addition to Customer and Checkout Session creation.

Leave all three Stripe variables empty when not testing billing. The API then reports billing as unavailable and the UI does not offer a Checkout action. When billing is configured, Checkout is offered only for the initial inactive state or after a terminal `canceled`/`incomplete_expired` subscription; other states fail closed without another Stripe call.

The Checkout success redirect is never treated as authorization. On return, the frontend requests `/api/user`; only verified webhook-synchronized MySQL state unlocks nutrition. For a production launch, review tax obligations and configure Stripe Tax only after adding the applicable tax registrations.

## Internationalization

The manually selectable locales are exactly English (`en`), Dutch (`nl`), German (`de`), and French (`fr`). One typed dictionary translates application-owned search, state, subscription, nutrition, and recent-search copy.

Each search sends the selected locale to Express. Product names follow this fallback:

```text
Open Food Facts product_name_<selected locale>
→ generic product_name
→ localized “Unavailable” UI label
```

Brands and images use explicit localized unavailable states. Foodscope does not translate product data that Open Food Facts does not supply. Selecting a saved recent search restores its locale before rerunning it.

## Testing and quality checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:coverage -w backend # optional local HTML coverage report
```

GitHub Actions runs these checks on pull requests and `main`, cancels superseded runs, replays all
migrations on disposable MySQL, and then runs the database integration suites sequentially.

The behavioral suite covers invalid search input, Open Food Facts normalization and locale fallback, malformed/missing fields, inactive nutrition redaction, active nutrition delivery, search persistence/retrieval, safe upstream errors, webhook-driven subscription synchronization, invalid webhook signatures, and a frontend locale/search interaction. External requests are mocked during normal tests.

## Technical decisions

- Product records are not persisted; Open Food Facts remains the product source of truth.
- The UI visibly attributes Open Food Facts data under ODbL and product images under CC BY-SA 3.0.
- A selected-locale field request, 1 MiB response ceiling, and small DTO bound upstream transfer and
  prevent leaking the large provider payload or provider-specific field names.
- The Express response is reconstructed from explicitly public product fields for inactive users, so restricted values cannot cross the API boundary.
- Stripe Customer and Subscription metadata plus stored Stripe IDs resolve events to the known user; clients cannot assert identity or entitlement.
- Checkout configuration failures return safe status messages without exposing provider objects, secrets, or stack traces.
- Browser API calls have bounded, workflow-specific deadlines; stalled account, search, and Checkout
  requests return to an explicit retry path instead of leaving controls permanently busy.
- The frontend sets framing, base/form, referrer, MIME-sniffing, and unused-capability restrictions on
  every document response; transport security remains the deployment host's responsibility.

## Intentional simplifications and known limitations

- Exactly one seeded demo user; no registration, login, passwords, OAuth, account management, or admin surface.
- Stripe test mode only; there is one monthly Price and no Customer Portal/cancellation UI.
- Recent searches are an eight-item view of persisted history, not deduplicated or user-editable.
- Open Food Facts coverage and translations vary by contributor; missing data stays visibly unavailable.
- The API has assessment-scale CORS, validation, body limits, security headers, and bounded HTTP connection/request lifetimes. Search and Checkout are origin-checked POST workflows so third-party pages cannot trigger their provider calls or demo-user writes. The Open Food Facts adapter enforces its documented per-process search budget, but there is no distributed public-internet rate limiter.
- Tax calculation is intentionally not enabled; real charging would require registrations and a tax review.

## Project structure

```text
foodscope/
├── frontend/           # Next.js UI, typed dictionaries, component test
├── backend/
│   ├── prisma/         # schema, migration, deterministic seed
│   ├── src/            # Express app, providers, repository
│   └── tests/          # API and normalization tests
├── docker-compose.yml  # local MySQL
├── .env.example
└── package.json        # workspace commands
```

## Evaluator fast path

1. Complete local setup and open the app; search for `oat milk`.
2. Change among EN/NL/DE/FR and confirm the UI and subsequent search locale update.
3. Click a recent-search chip to rerun it with its saved locale.
4. Inspect an inactive search response: it contains `nutritionLocked: true` and no `nutrition` property.
5. Configure Stripe test values, run webhook forwarding, and complete Checkout.
6. Wait for the verified subscription event; reload/return to see the active status.
7. Search again and inspect the now-unlocked available nutrition fields.
8. Run the four quality commands above.
