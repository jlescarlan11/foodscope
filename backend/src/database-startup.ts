import type { PrismaClient } from '@prisma/client';
import { ensureDemoUser } from './demo-user.js';

type StartupDatabase = Pick<PrismaClient, '$connect' | '$disconnect' | 'user'>;

export async function initializeDatabase(database: StartupDatabase) {
  try {
    await database.$connect();
    await ensureDemoUser(database);
    return true;
  } catch {
    console.error('Database initialization failed during startup');
    try {
      await database.$disconnect();
    } catch {
      console.error('Unable to close the database connection after startup failure');
    }
    return false;
  }
}
