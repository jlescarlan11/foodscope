import { describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../src/database-startup.js';
import type { prisma } from '../src/prisma.js';

describe('database startup', () => {
  it('keeps the connection open after successful initialization', async () => {
    const database = {
      $connect: vi.fn(async () => undefined),
      $disconnect: vi.fn(async () => undefined),
      user: { upsert: vi.fn(async () => undefined) },
    } as unknown as typeof prisma;

    await expect(initializeDatabase(database)).resolves.toBe(true);
    expect(database.$disconnect).not.toHaveBeenCalled();
  });

  it('awaits connection cleanup when demo-user initialization fails', async () => {
    const database = {
      $connect: vi.fn(async () => undefined),
      $disconnect: vi.fn(async () => undefined),
      user: { upsert: vi.fn(async () => { throw new Error('synthetic failure'); }) },
    } as unknown as typeof prisma;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(initializeDatabase(database)).resolves.toBe(false);

    expect(database.$disconnect).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('Database initialization failed during startup');
    error.mockRestore();
  });

  it('still reports failed startup when connection cleanup also fails', async () => {
    const database = {
      $connect: vi.fn(async () => { throw new Error('synthetic connection failure'); }),
      $disconnect: vi.fn(async () => { throw new Error('synthetic cleanup failure'); }),
      user: { upsert: vi.fn() },
    } as unknown as typeof prisma;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(initializeDatabase(database)).resolves.toBe(false);

    expect(database.$disconnect).toHaveBeenCalledOnce();
    expect(error).toHaveBeenLastCalledWith(
      'Unable to close the database connection after startup failure',
    );
    error.mockRestore();
  });
});
