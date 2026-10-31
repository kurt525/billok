import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { cleanupExpiredRegistrationRequests } from './registration-cleanup';

const now = new Date('2026-10-31T10:30:00.000Z');
const updateMany = vi.fn();
const deleteMany = vi.fn();
const db = {
  systemInvite: { updateMany },
  emailVerificationRequest: { deleteMany },
} as unknown as Pick<PrismaClient, 'systemInvite' | 'emailVerificationRequest'>;

beforeEach(() => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 2 });
  deleteMany.mockResolvedValue({ count: 4 });
});

describe('expired registration confirmation cleanup', () => {
  it('releases only expired unconsumed reservations and deletes only expired links', async () => {
    await expect(cleanupExpiredRegistrationRequests(db, now)).resolves.toEqual({
      releasedReservations: 2,
      deletedTokens: 4,
    });

    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        reservedById: { not: null },
        reservedUntil: { lte: now },
        usedById: null,
        usedAt: null,
      },
      data: { reservedById: null, reservedUntil: null },
    });
    expect(deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { expiresAt: { lte: now } },
    });
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[0]!);
  });

  it('is safe to repeat after everything eligible has already been removed', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    deleteMany.mockResolvedValue({ count: 0 });

    const first = await cleanupExpiredRegistrationRequests(db, now);
    const second = await cleanupExpiredRegistrationRequests(db, now);

    expect(first).toEqual({ releasedReservations: 0, deletedTokens: 0 });
    expect(second).toEqual(first);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it('does not continue to token deletion after a database failure', async () => {
    updateMany.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(cleanupExpiredRegistrationRequests(db, now)).rejects.toThrow('Database unavailable');
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('reports token cleanup failures instead of claiming completion', async () => {
    deleteMany.mockRejectedValueOnce(new Error('Token cleanup failed'));
    await expect(cleanupExpiredRegistrationRequests(db, now)).rejects.toThrow('Token cleanup failed');
    expect(updateMany).toHaveBeenCalledOnce();
  });
});
