import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { finalizePendingVerificationResend } from './registration-resend-finalization';

const now = new Date('2026-11-01T16:00:00.000Z');
const createdAt = new Date('2026-11-01T15:59:00.000Z');
const expiresAt = new Date('2026-11-01T16:29:00.000Z');
const findUnique = vi.fn();
const updateMany = vi.fn();
const db = { emailVerificationRequest: { findUnique, updateMany } } as unknown as Pick<
  PrismaClient,
  'emailVerificationRequest'
>;
const input = { userId: 'pending-1', requestId: 'new-request-1', now };

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ userId: 'pending-1', createdAt, expiresAt, consumedAt: null });
  updateMany.mockResolvedValue({ count: 2 });
});

describe('safe retirement of older confirmation links after resend', () => {
  it('marks only older unused links of the same still-unverified account as consumed', async () => {
    await expect(finalizePendingVerificationResend(db, input)).resolves.toBe(2);
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'new-request-1' },
      select: { userId: true, createdAt: true, expiresAt: true, consumedAt: true },
    });
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        userId: 'pending-1',
        id: { not: 'new-request-1' },
        consumedAt: null,
        createdAt: { lt: createdAt },
        user: {
          is: { id: 'pending-1', emailVerified: null, registrationEmailVerificationRequired: true },
        },
      },
      data: { consumedAt: now },
    });
    expect(findUnique.mock.invocationCallOrder[0]!).toBeLessThan(updateMany.mock.invocationCallOrder[0]!);
  });

  it('leaves all other requests intact if the replacement belongs to another account', async () => {
    findUnique.mockResolvedValueOnce({ userId: 'other-account', createdAt, expiresAt, consumedAt: null });
    await expect(finalizePendingVerificationResend(db, input)).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['already consumed', { userId: 'pending-1', createdAt, expiresAt, consumedAt: now }],
    ['expired', { userId: 'pending-1', createdAt, expiresAt: now, consumedAt: null }],
  ])('does not invalidate anything when the replacement is %s or missing', async (_name, request) => {
    findUnique.mockResolvedValueOnce(request);
    await expect(finalizePendingVerificationResend(db, input)).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('returns zero and does not retry when old links were already used or no longer eligible', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(finalizePendingVerificationResend(db, input)).resolves.toBe(0);
    expect(updateMany).toHaveBeenCalledOnce();
  });
});
