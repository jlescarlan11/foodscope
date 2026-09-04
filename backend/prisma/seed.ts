import { PrismaClient } from '@prisma/client';
import { DEMO_USER_EMAIL, DEMO_USER_ID } from '../src/constants.js';

const prisma = new PrismaClient();

async function main() {
  await prisma.stripeWebhookEvent.deleteMany();
  await prisma.recentSearch.deleteMany();
  await prisma.user.deleteMany({ where: { id: { not: DEMO_USER_ID } } });
  await prisma.user.upsert({
    where: { id: DEMO_USER_ID },
    update: {
      email: DEMO_USER_EMAIL,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: 'inactive',
      subscriptionCurrentPeriodEnd: null,
    },
    create: { id: DEMO_USER_ID, email: DEMO_USER_EMAIL, subscriptionStatus: 'inactive' },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error('Unable to seed the demo user.');
    await prisma.$disconnect();
    throw error;
  });
