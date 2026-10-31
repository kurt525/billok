import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { redeemReservedSystemInvite } from './invite-redemption';

const now = new Date('2026-10-31T10:15:00.000Z');
const input = { code: 'single-use-code', userId: 'verified-user', now };

describe('invitation redemption after email verification', () => {
  it('atomically checks the owner, verified email, active lease and invitation validity', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { systemInvite: { updateMany } } as unknown as Pick<PrismaClient, 'systemInvite'>;

    await expect(redeemReservedSystemInvite(db, input)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        code: input.code,
        reservedById: input.userId,
        reservedUntil: { gt: now },
        reservedBy: { is: { id: input.userId, emailVerified: { not: null } } },
        usedById: null,
        usedAt: null,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: {
        usedById: input.userId,
        usedAt: now,
        reservedById: null,
        reservedUntil: null,
      },
    });
  });

  it('rejects a nonmatching, expired, revoked or already claimed reservation', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const db = { systemInvite: { updateMany } } as unknown as Pick<PrismaClient, 'systemInvite'>;
    await expect(redeemReservedSystemInvite(db, input)).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it('allows only one successful redemption when simultaneous attempts compete', async () => {
    let available = true;
    const updateMany = vi.fn().mockImplementation(async () => {
      if (!available) return { count: 0 };
      available = false;
      return { count: 1 };
    });
    const db = { systemInvite: { updateMany } } as unknown as Pick<PrismaClient, 'systemInvite'>;
    const attempts = await Promise.all([redeemReservedSystemInvite(db, input), redeemReservedSystemInvite(db, input)]);
    expect(attempts).toEqual([true, false]);
  });
});
