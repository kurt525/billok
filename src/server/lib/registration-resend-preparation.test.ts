import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { hashEmailVerificationToken } from './email-verification-token';
import { preparePendingVerificationResend } from './registration-resend-preparation';

const now = new Date('2026-11-01T15:00:00.000Z');
const updateMany = vi.fn();
const create = vi.fn();
const tx = { systemInvite: { updateMany }, emailVerificationRequest: { create } };
const transaction = vi.fn(async (operation: (arg: typeof tx) => Promise<unknown>) => operation(tx));
const db = { $transaction: transaction } as unknown as Pick<PrismaClient, '$transaction'>;
const input = { userId: 'pending-1', inviteCode: 'my-invite', siteOrigin: 'https://billok.ru', now };

beforeEach(() => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
  create.mockResolvedValue({ id: 'new-token-row' });
});

describe('atomic preparation of a replacement confirmation token', () => {
  it('checks lease ownership in the transaction and persists only a token hash', async () => {
    const result = await preparePendingVerificationResend(db, input);
    expect(transaction).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        code: 'my-invite',
        reservedById: 'pending-1',
        reservedUntil: { gt: now },
        reservedBy: {
          is: { id: 'pending-1', emailVerified: null, registrationEmailVerificationRequired: true },
        },
        usedById: null,
        usedAt: null,
        revokedAt: null,
        createdAt: { gt: new Date(now.getTime() - 7 * 86_400_000) },
        expiresAt: { gt: now },
      },
      data: { reservedUntil: new Date('2026-11-01T15:30:00.000Z') },
    });
    const token = new URL(result!.url).searchParams.get('token');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      data: {
        userId: 'pending-1',
        tokenHash: hashEmailVerificationToken(token!),
        expiresAt: new Date('2026-11-01T15:30:00.000Z'),
      },
      select: { id: true },
    });
    expect(result).toEqual({
      requestId: 'new-token-row',
      url: result!.url,
      expiresAt: new Date('2026-11-01T15:30:00.000Z'),
    });
    expect(create.mock.invocationCallOrder[0]).toBeGreaterThan(updateMany.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(create.mock.calls)).not.toContain(token);
  });

  it('does not issue a new token when the lease is expired, freed or otherwise not owned', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(preparePendingVerificationResend(db, input)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('propagates storage errors so the real database can roll back the lease renewal', async () => {
    create.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(preparePendingVerificationResend(db, input)).rejects.toThrow('Database unavailable');
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('refuses an unsafe link origin before renewing the lease or writing any token', async () => {
    await expect(preparePendingVerificationResend(db, { ...input, siteOrigin: 'http://billok.ru' })).rejects.toThrow(
      'Не задан корректный адрес BillOK',
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
