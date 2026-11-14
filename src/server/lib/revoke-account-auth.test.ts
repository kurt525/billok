import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { revokeAccountAuthenticationState } from './revoke-account-auth';

function fixture(count = 1) {
  const tx = {
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: 'user-1' }]),
    user: { updateMany: vi.fn().mockResolvedValue({ count }) },
    webAuthnChallenge: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    passkeyLoginTicket: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
    session: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const db = {
    $transaction: vi.fn(async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { tx, db: db as unknown as PrismaClient };
}

describe('Issue #1 6.8.1.1 — internal account recovery revocation', () => {
  it('atomically increments the JWT security version and deletes prior one-time auth state', async () => {
    const { db, tx } = fixture();
    expect(await revokeAccountAuthenticationState({ db, userId: 'user-1' })).toEqual({ revoked: true });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'user-1');
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { sessionSecurityVersion: { increment: 1 } },
    });
    for (const action of [tx.webAuthnChallenge.deleteMany, tx.passkeyLoginTicket.deleteMany, tx.session.deleteMany]) {
      expect(action).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    }
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not touch any auth records if the account no longer exists', async () => {
    const { db, tx } = fixture(0);
    await expect(revokeAccountAuthenticationState({ db, userId: 'user-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(tx.webAuthnChallenge.deleteMany).not.toHaveBeenCalled();
    expect(tx.passkeyLoginTicket.deleteMany).not.toHaveBeenCalled();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects blank account IDs before starting a transaction', async () => {
    const { db } = fixture();
    await expect(revokeAccountAuthenticationState({ db, userId: ' ' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
