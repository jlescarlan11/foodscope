import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { OpenFoodFactsProvider } from './open-food-facts.js';
import { prisma } from './prisma.js';
import { repository } from './repository.js';
import { createBillingProvider } from './stripe.js';
import { startHttpServer } from './http-server.js';
import { disconnectDatabase, initializeDatabase } from './database-startup.js';

const config = loadConfig();

const app = createApp({
  config,
  repository,
  products: new OpenFoodFactsProvider(config.openFoodFactsUserAgent),
  billing: createBillingProvider(config, repository),
});

async function start() {
  if (!await initializeDatabase(prisma)) {
    process.exitCode = 1;
    return;
  }

  const server = startHttpServer(app, config.port, config.host, () => {
    const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`Foodscope API listening on http://${displayHost}:${config.port}`);
  });
  const closeDatabase = () => {
    void disconnectDatabase(prisma).then((closed) => {
      if (!closed) process.exitCode = 1;
    });
  };
  server.once('error', () => {
    console.error('Foodscope API failed to listen');
    process.exitCode = 1;
    closeDatabase();
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(closeDatabase);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void start();
