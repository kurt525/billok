import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { assertPasskeyEnrollmentCapacity, OWNER_PASSKEY_LIMIT, REGULAR_PASSKEY_LIMIT } from './passkey-account-limit';

function fixture(input?: { ownerId?: string; completed?: boolean; active?: number; accountExists?: boolean }) {
  const sequence: string[] = [];
  const tx = {
    $queryRawUnsafe: vi.fn().mockImplementation(async () => {
      sequence.push('lock');
      return input?.accountExists === false ? [] : [{ id: 'user-1' }];
    }),
    ownerBootstrap: {
      findUnique: vi.fn().mockImplementation(async () => {
        sequence.push('owner');
        return input?.ownerId ? { userId: input.ownerId, completedAt: input.completed ? new Date() : null } : null;
      }),
    },
    passkeyCredential: {
      count: vi.fn().mockImplementation(async () => {
        sequence.push('count');
        return input?.active ?? 0;
      }),
    },
  };
  return { db: tx as unknown as Prisma.TransactionClient, tx, sequence };
}

describe('Issue #1 6.8.1.2: one active Passkey for regular accounts', () => {
  it('limits every non-owner account to a single active key, always checking under a row lock', async () => {
    const { db, tx, sequence } = fixture();
    expect(await assertPasskeyEnrollmentCapacity(db, 'user-1', 'FIRST')).toEqual({
      activeCount: 0,
      maxActive: REGULAR_PASSKEY_LIMIT,
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'user-1');
    expect(tx.passkeyCredential.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
    });
    expect(sequence).toEqual(['lock', 'owner', 'count']);
  });

  it('rejects a second regular key even when it has a different credential ID', async () => {
    const { db } = fixture({ active: 1 });
    await expect(assertPasskeyEnrollmentCapacity(db, 'user-1', 'FIRST')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('never admits OWNER_ADDITIONAL for ordinary users', async () => {
    for (const active of [0, 1]) {
      const { db, tx } = fixture({ active });
      await expect(assertPasskeyEnrollmentCapacity(db, 'user-1', 'OWNER_ADDITIONAL')).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(tx.passkeyCredential.count).not.toHaveBeenCalled();
    }
  });

  it('a pending owner bootstrap cannot bypass the one-key rule', async () => {
    const { db } = fixture({ ownerId: 'user-1', completed: false, active: 1 });
    await expect(assertPasskeyEnrollmentCapacity(db, 'user-1', 'FIRST')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(assertPasskeyEnrollmentCapacity(db, 'user-1', 'OWNER_ADDITIONAL')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('requires the owner ID to match exactly, not merely an existing owner row', async () => {
    const { db } = fixture({ ownerId: 'someone-else', completed: true, active: 1 });
    await expect(assertPasskeyEnrollmentCapacity(db, 'user-1', 'OWNER_ADDITIONAL')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('lets the completed owner add only a second and third key', async () => {
    for (const active of [1, 2]) {
      const { db } = fixture({ ownerId: 'user-1', completed: true, active });
      expect(await assertPasskeyEnrollmentCapacity(db, 'user-1', 'OWNER_ADDITIONAL')).toEqual({
        activeCount: active,
        maxActive: OWNER_PASSKEY_LIMIT,
      });
    }
    const { db } = fixture({ ownerId: 'user-1', completed: true, active: 3 });
    await expect(assertPasskeyEnrollmentCapacity(db, 'user-1', 'OWNER_ADDITIONAL')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('never reopens initial setup after a first valid key, including for the owner', async () => {
    const { db } = fixture({ ownerId: 'user-1', completed: true, active: 1 });
    await expect(assertPasskeyEnrollmentCapacity(db, 'user-1', 'FIRST')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('fails closed for a missing user ID or a row deleted before locking', async () => {
    const { db, tx } = fixture();
    await expect(assertPasskeyEnrollmentCapacity(db, ' ', 'FIRST')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    const missing = fixture({ accountExists: false });
    await expect(assertPasskeyEnrollmentCapacity(missing.db, 'user-1', 'FIRST')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(missing.tx.ownerBootstrap.findUnique).not.toHaveBeenCalled();
    expect(missing.tx.passkeyCredential.count).not.toHaveBeenCalled();
  });
});
