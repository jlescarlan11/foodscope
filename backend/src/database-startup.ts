import type { PrismaClient } from '@prisma/client';
import { ensureDemoUser } from './demo-user.js';

type StartupDatabase = Pick<PrismaClient, '$connect' | '$disconnect' | 'user'>;
type DisconnectableDatabase = Pick<PrismaClient, '$disconnect'>;

export async function disconnectDatabase(database: DisconnectableDatabase) {
  try {
    await database.$disconnect();
    return true;
  } catch {
    console.error('Unable to close the database connection');
    return false;
  }
}

export async function initializeDatabase(database: StartupDatabase) {
  try {
    await database.$connect();
    await ensureDemoUser(database);
    return true;
  } catch {
    console.error('Database initialization failed during startup');
    await disconnectDatabase(database);
    return false;
  }
}
