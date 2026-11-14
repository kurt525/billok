import { beforeEach, describe, expect, test, vi } from 'vitest';

const { confirm, fingerprint, changeSuspension, requireOwner, events } = vi.hoisted(() => ({
  confirm: vi.fn(),
  fingerprint: vi.fn(),
  changeSuspension: vi.fn(),
  requireOwner: vi.fn(),
  events: [] as string[],
}));

vi.mock('@/server/lib/owner-access', () => ({ requireOwner }));
vi.mock('@/server/lib/owner-passkey-action-approval', () => ({
  consumeOwnerPasskeyActionProof: confirm,
  ownerSessionFingerprint: fingerprint,
}));
vi.mock('@/server/lib/owner-user-admin', () => ({
  listOwnerRegisteredUsers: vi.fn(),
  changeRegisteredUserSuspension: changeSuspension,
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('next/headers', () => ({ cookies: vi.fn().mockResolvedValue({ get: () => null }) }));

import { adminRouter } from './admin';

function fixture() {
  const owner = { id: 'owner-1', email: 'owner@mail.ru' };
  const target = { id: 'user-1', email: 'member@mail.ru', isPlaceholder: false };
  const tx = {
    $queryRawUnsafe: vi.fn(async (_sql: string, userId: string) => {
      events.push('lock:' + userId);
      return [{ id: userId }];
    }),
    ownerBootstrap: { findUnique: vi.fn().mockResolvedValue({ userId: owner.id, completedAt: new Date() }) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === target.id ? target : null)),
      update: vi.fn().mockImplementation(async () => {
        events.push('update');
        return target;
      }),
    },
    session: {
      deleteMany: vi.fn().mockImplementation(async () => {
        events.push('revoke-sessions');
        return { count: 1 };
      }),
    },
    passkeyLoginTicket: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    webAuthnChallenge: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    passkeyCredential: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    groupMember: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    adminAuditLog: {
      create: vi.fn().mockImplementation(async () => {
        events.push('audit');
        return { id: 'audit-1' };
      }),
    },
  };
  const db = {
    // tRPC protectedProcedure separately verifies a non-suspended session.
    user: { findUnique: vi.fn().mockResolvedValue({ suspendedAt: null }) },
    $transaction: vi.fn(async (call: (client: unknown) => Promise<unknown>) => {
      events.push('transaction:start');
      const value = await call(tx);
      events.push('transaction:commit');
      return value;
    }),
  };
  const caller = adminRouter.createCaller({
    session: { user: owner },
    db,
    headers: new Headers({ cookie: 'authjs.session-token=valid-owner-login' }),
    impersonating: null,
  } as unknown as Parameters<typeof adminRouter.createCaller>[0]);
  return { caller, db, tx, owner, target };
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  requireOwner.mockResolvedValue(undefined);
  fingerprint.mockReturnValue('a'.repeat(64));
  changeSuspension.mockImplementation(async (input: { userId: string; suspend: boolean }) => ({
    suspended: input.suspend,
    userId: input.userId,
  }));
  confirm.mockImplementation(async () => {
    events.push('proof:consumed');
  });
});

describe('Issue 6.12.4.2: every admin user mutation requires a fresh Passkey proof', () => {
  test('all four entrypoints reject missing proof and do not touch PostgreSQL', async () => {
    const { caller, db } = fixture();
    await expect(caller.ownerSetUserSuspended({ userId: 'user-1', suspend: true } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.suspendUser({ userId: 'user-1' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.unsuspendUser({ userId: 'user-1' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.deleteUser({ userId: 'user-1' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(changeSuspension).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  test('both legacy methods and dedicated page supply the specific operation, target and current cookie', async () => {
    const { caller } = fixture();
    const approvalToken = 'b'.repeat(43);
    await caller.ownerSetUserSuspended({ userId: 'user-1', suspend: true, approvalToken });
    await caller.suspendUser({ userId: 'user-1', approvalToken });
    await caller.unsuspendUser({ userId: 'user-1', approvalToken });
    expect(fingerprint).toHaveBeenCalledTimes(3);
    expect(changeSuspension).toHaveBeenCalledTimes(3);
    expect(
      changeSuspension.mock.calls.map(([input]) => [
        input.suspend,
        input.userId,
        input.approvalToken,
        input.sessionHash,
      ]),
    ).toEqual([
      [true, 'user-1', approvalToken, 'a'.repeat(64)],
      [true, 'user-1', approvalToken, 'a'.repeat(64)],
      [false, 'user-1', approvalToken, 'a'.repeat(64)],
    ]);
  });

  test('deletion consumes the exact USER_DELETE proof before touching account data, in one transaction', async () => {
    const { caller, db, tx } = fixture();
    const approvalToken = 'b'.repeat(43);
    await expect(caller.deleteUser({ userId: 'user-1', approvalToken })).resolves.toMatchObject({
      deleted: true,
      userId: 'user-1',
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        userId: 'owner-1',
        targetId: 'user-1',
        action: 'USER_DELETE',
        sessionHash: 'a'.repeat(64),
        approvalToken,
      }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        'transaction:start',
        'lock:owner-1',
        'lock:user-1',
        'proof:consumed',
        'update',
        'revoke-sessions',
        'audit',
        'transaction:commit',
      ]),
    );
    expect(events.indexOf('proof:consumed')).toBeLessThan(events.indexOf('update'));
    expect(events.indexOf('audit')).toBeLessThan(events.indexOf('transaction:commit'));
    expect(tx.passkeyLoginTicket.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  test('replayed, cross-user, expired and wrong-action proof cannot delete a user', async () => {
    for (const reason of ['replayed', 'wrong-action', 'wrong-target', 'expired', 'wrong-session']) {
      const { caller, tx } = fixture();
      confirm.mockRejectedValueOnce(new Error(reason));
      await expect(caller.deleteUser({ userId: 'user-1', approvalToken: 'b'.repeat(43) })).rejects.toThrow(reason);
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.session.deleteMany).not.toHaveBeenCalled();
      expect(tx.passkeyLoginTicket.deleteMany).not.toHaveBeenCalled();
      expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
    }
  });

  test('the immutable owner cannot be deleted or impersonation used as a privileged route', async () => {
    const { caller, tx } = fixture();
    await expect(caller.deleteUser({ userId: 'owner-1', approvalToken: 'b'.repeat(43) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    const impersonating = adminRouter.createCaller({
      session: { user: { id: 'owner-1' } },
      db: { user: { findUnique: vi.fn().mockResolvedValue({ suspendedAt: null }) } },
      headers: new Headers({ cookie: 'authjs.session-token=owner' }),
      impersonating: { adminId: 'owner-1', targetId: 'user-1' },
    } as unknown as Parameters<typeof adminRouter.createCaller>[0]);
    await expect(impersonating.deleteUser({ userId: 'user-1', approvalToken: 'b'.repeat(43) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});
