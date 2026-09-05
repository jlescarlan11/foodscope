import { describe, expect, it, vi } from 'vitest';
import { DEMO_USER_EMAIL, DEMO_USER_ID } from '../src/constants.js';
import { ensureDemoUser } from '../src/demo-user.js';
import { prisma } from '../src/prisma.js';

describe('demo user initialization', () => {
  it('creates the deterministic user without overwriting existing state', async () => {
    const upsert = vi.fn(async () => undefined);

    await ensureDemoUser({ user: { upsert } } as unknown as Pick<typeof prisma, 'user'>);

    expect(upsert).toHaveBeenCalledWith({
      where: { id: DEMO_USER_ID },
      update: {},
      create: { id: DEMO_USER_ID, email: DEMO_USER_EMAIL, subscriptionStatus: 'inactive' },
    });
  });
});
