import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { reserveSystemInvite } from './invite-reservation';

const now = new Date('2026-10-31T10:00:00.000Z');

describe('atomic single-use invite reservation', () => {
  it('uses a single conditional update without consuming the invitation', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { systemInvite: { updateMany } } as unknown as Pick<PrismaClient, 'systemInvite'>;
    await expect(reserveSystemInvite(db, { code: 'invite-1', userId: 'new-user', now })).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        code: 'invite-1',
        usedAt: null,
        usedById: null,
        revokedAt: null,
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          { OR: [{ reservedUntil: null }, { reservedUntil: { lte: now } }] },
        ],
      },
      data: {
        reservedById: 'new-user',
        reservedUntil: new Date('2026-10-31T10:30:00.000Z'),
      },
    });
    const data = updateMany.mock.lastCall?.[0]?.data;
    expect(data).not.toHaveProperty('usedAt');
    expect(data).not.toHaveProperty('usedById');
  });

  it('returns false if the conditional update claimed nothing', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const db = { systemInvite: { updateMany } } as unknown as Pick<PrismaClient, 'systemInvite'>;
    await expect(reserveSystemInvite(db, { code: 'taken', userId: 'other', now })).resolves.toBe(false);
  });

  it('permits a free or expired reservation but never replaces a live reservation', async () => {
    const existing = {
      code: 'single-use',
      usedAt: null as Date | null,
      revokedAt: null as Date | null,
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
      reservedById: null as string | null,
      reservedUntil: null as Date | null,
    };
    const updateMany = vi.fn().mockImplementation(async ({ where, data }) => {
      // Simulate one atomic database UPDATE: inspect and assign before yielding.
      const allowed =
        existing.code === where.code &&
        existing.usedAt === null &&
        existing.revokedAt === null &&
        (existing.expiresAt === null || existing.expiresAt > now) &&
        (existing.reservedUntil === null || existing.reservedUntil <= now);
      if (!allowed) return { count: 0 };
      existing.reservedById = data.reservedById;
      existing.reservedUntil = data.reservedUntil;
      return { count: 1 };
    });
    const db = { systemInvite: { updateMany } } as unknown as Pick<PrismaClient, 'systemInvite'>;

    const outcome = await Promise.all([
      reserveSystemInvite(db, { code: 'single-use', userId: 'first', now }),
      reserveSystemInvite(db, { code: 'single-use', userId: 'second', now }),
    ]);
    expect(outcome).toEqual([true, false]);
    expect(existing.reservedById).toBe('first');
    expect(existing.usedAt).toBeNull();
  });
});
