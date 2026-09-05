import type { PrismaClient } from '@prisma/client';
import { DEMO_USER_EMAIL, DEMO_USER_ID } from './constants.js';

export async function ensureDemoUser(database: Pick<PrismaClient, 'user'>) {
  await database.user.upsert({
    where: { id: DEMO_USER_ID },
    update: {},
    create: { id: DEMO_USER_ID, email: DEMO_USER_EMAIL, subscriptionStatus: 'inactive' },
  });
}
