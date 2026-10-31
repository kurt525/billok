import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashEmailVerificationToken } from './email-verification-token';
import { confirmRegistrationEmail } from './registration-email-confirmation';

const { cleanupGate } = vi.hoisted(() => ({ cleanupGate: vi.fn() }));
vi.mock('./registration-cleanup-trigger', () => ({ runRegistrationCleanupIfDue: cleanupGate }));

const token = 'A'.repeat(43);
const now = new Date('2026-10-31T10:15:00.000Z');
const expiresAt = new Date('2026-10-31T10:30:00.000Z');

function fixture() {
  const tx = {
    emailVerificationRequest: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'request-1',
        userId: 'user-1',
        consumedAt: null,
        expiresAt,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    systemInvite: {
      findFirst: vi.fn().mockResolvedValue({ code: 'invite-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    systemInvite: tx.systemInvite,
    emailVerificationRequest: tx.emailVerificationRequest,
  } as unknown as Parameters<typeof confirmRegistrationEmail>[0];
  return { db, tx };
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanupGate.mockResolvedValue(undefined);
});

describe('atomic registration email confirmation', () => {
  it('consumes the hash, verifies the owner, redeems the reserved invite, then runs cleanup', async () => {
    const { db, tx } = fixture();
    expect(await confirmRegistrationEmail(db, token, now)).toBe(true);
    expect(tx.emailVerificationRequest.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashEmailVerificationToken(token) },
      select: { id: true, userId: true, consumedAt: true, expiresAt: true },
    });
    expect(tx.emailVerificationRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'request-1', userId: 'user-1', consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', emailVerified: null },
      data: { emailVerified: now },
    });
    expect(tx.systemInvite.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          code: 'invite-1',
          reservedById: 'user-1',
          reservedUntil: { gt: now },
        }),
        data: {
          usedById: 'user-1',
          usedAt: now,
          reservedById: null,
          reservedUntil: null,
        },
      }),
    );
    expect(cleanupGate).toHaveBeenCalledExactlyOnceWith(db);
    const [transactionOrder] = vi.mocked(db.$transaction).mock.invocationCallOrder;
    const [cleanupOrder] = cleanupGate.mock.invocationCallOrder;
    if (transactionOrder === undefined || cleanupOrder === undefined) {
      throw new Error('Expected confirmation transaction and cleanup');
    }
    expect(transactionOrder).toBeLessThan(cleanupOrder);
  });

  it.each(['', 'bad', '!'.repeat(43)])('rejects a malformed token without database writes', async (invalid) => {
    const { db } = fixture();
    expect(await confirmRegistrationEmail(db, invalid, now)).toBe(false);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(cleanupGate).not.toHaveBeenCalled();
  });

  it('rejects expired and consumed links, including the exact expiry boundary', async () => {
    const { db, tx } = fixture();
    tx.emailVerificationRequest.findUnique
      .mockResolvedValueOnce({
        id: 'request-1',
        userId: 'user-1',
        consumedAt: null,
        expiresAt: now,
      })
      .mockResolvedValueOnce({
        id: 'request-1',
        userId: 'user-1',
        consumedAt: now,
        expiresAt,
      });
    expect(await confirmRegistrationEmail(db, token, now)).toBe(false);
    expect(await confirmRegistrationEmail(db, token, now)).toBe(false);
    expect(tx.systemInvite.findFirst).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(cleanupGate).not.toHaveBeenCalled();
  });

  it('does not consume a token when its invitation has no valid reservation', async () => {
    const { db, tx } = fixture();
    tx.systemInvite.findFirst.mockResolvedValue(null);
    expect(await confirmRegistrationEmail(db, token, now)).toBe(false);
    expect(tx.emailVerificationRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(cleanupGate).not.toHaveBeenCalled();
  });

  it.each(['token', 'user', 'invite'])('rolls back when the %s update loses a race', async (failed) => {
    const { db, tx } = fixture();
    if (failed === 'token') tx.emailVerificationRequest.updateMany.mockResolvedValue({ count: 0 });
    if (failed === 'user') tx.user.updateMany.mockResolvedValue({ count: 0 });
    if (failed === 'invite') tx.systemInvite.updateMany.mockResolvedValue({ count: 0 });
    expect(await confirmRegistrationEmail(db, token, now)).toBe(false);
    expect(cleanupGate).not.toHaveBeenCalled();
  });

  it('propagates real database failures rather than pretending the link expired', async () => {
    const { db, tx } = fixture();
    tx.emailVerificationRequest.findUnique.mockRejectedValue(new Error('Database offline'));
    await expect(confirmRegistrationEmail(db, token, now)).rejects.toThrow('Database offline');
    expect(cleanupGate).not.toHaveBeenCalled();
  });
});
