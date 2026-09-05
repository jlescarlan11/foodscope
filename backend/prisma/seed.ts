import { PrismaClient } from '@prisma/client';
import { ensureDemoUser } from '../src/demo-user.js';

const prisma = new PrismaClient();

async function main() {
  await ensureDemoUser(prisma);
}

async function run() {
  try {
    await main();
  } catch {
    console.error('Unable to seed the demo user.');
    process.exitCode = 1;
  } finally {
    try {
      await prisma.$disconnect();
    } catch {
      console.error('Unable to close the database connection.');
      process.exitCode = 1;
    }
  }
}

void run();
