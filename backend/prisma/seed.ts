import { PrismaClient } from '@prisma/client';
import { ensureDemoUser } from '../src/demo-user.js';

const prisma = new PrismaClient();

async function main() {
  await ensureDemoUser(prisma);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error('Unable to seed the demo user.');
    await prisma.$disconnect();
    throw error;
  });
