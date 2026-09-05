import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { OpenFoodFactsProvider } from './open-food-facts.js';
import { prisma } from './prisma.js';
import { repository } from './repository.js';
import { createBillingProvider } from './stripe.js';
import { configureHttpServer } from './http-server.js';
import { ensureDemoUser } from './demo-user.js';

const config = loadConfig();

const app = createApp({
  config,
  repository,
  products: new OpenFoodFactsProvider(config.openFoodFactsUserAgent),
  billing: createBillingProvider(config, repository),
});

async function start() {
  try {
    await prisma.$connect();
    await ensureDemoUser(prisma);
  } catch {
    console.error('Database initialization failed during startup');
    process.exitCode = 1;
    return;
  }

  const server = app.listen(config.port, () => {
    console.log(`Foodscope API listening on http://localhost:${config.port}`);
  });
  configureHttpServer(server);
  server.once('error', () => {
    console.error('Foodscope API failed to listen');
    process.exitCode = 1;
    void prisma.$disconnect();
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => void prisma.$disconnect());
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void start();
