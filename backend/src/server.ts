import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { OpenFoodFactsProvider } from './open-food-facts.js';
import { prisma } from './prisma.js';
import { repository } from './repository.js';
import { createBillingProvider } from './stripe.js';

const config = loadConfig();

const app = createApp({
  config,
  repository,
  products: new OpenFoodFactsProvider(config.openFoodFactsUserAgent),
  billing: createBillingProvider(config, repository),
});

const server = app.listen(config.port, () => {
  console.log(`Foodscope API listening on http://localhost:${config.port}`);
});

const shutdown = () => {
  server.close(() => void prisma.$disconnect());
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
