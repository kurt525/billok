import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { requireRegisteredOwner, listOwnerRegisteredUsers, changeRegisteredUserSuspension } from './owner-user-admin';
import { consumeOwnerPasskeyActionProof } from './owner-passkey-action-approval';

vi.mock('./owner-passkey-action-approval', () => ({
  consumeOwnerPasskeyActionProof: vi.fn().mockResolvedValue(undefined),
}));

const now = new Date('2026-11-12T12:00:00Z');
function fixture() {
  const bootstrap = { userId: 'owner-id', completedAt: now as Date | null };
  const actor = {
    id: 'owner-id',
    emailVerified: now as Date | null,
    suspendedAt: null as Date | null,
    isPlaceholder: false,
    sessionSecurityVersion: 0,
  };
  const target = {
    id: 'member-id',
    email: 'member@mail.ru',
    emailVerified: now as Date | null,
    suspendedAt: null as Date | null,
    isPlaceholder: false,
  };
  const rows = [
    {
      id: 'owner-id',
      name: 'Владелец',
      email: 'owner@mail.ru',
      createdAt: now,
      suspendedAt: null as Date | null,
      emailVerified: now as Date | null,
    },
    {
      id: 'member-id',
      name: 'Участник',
      email: 'member@mail.ru',
      createdAt: now,
      suspendedAt: null as Date | null,
      emailVerified: now as Date | null,
    },
    {
      id: 'pending-id',
      name: 'Ожидает',
      email: 'pending@mail.ru',
      createdAt: now,
      suspendedAt: null as Date | null,
      emailVerified: null as Date | null,
    },
  ];
  const db = {
    ownerBootstrap: { findUnique: vi.fn(async () => bootstrap) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'owner-id' ? actor : where.id === 'member-id' ? target : null,
      ),
      findMany: vi.fn(async () => rows),
      count: vi.fn(async () => rows.length),
      updateMany: vi.fn(async ({ data }: { data: { suspendedAt?: Date | null; sessionSecurityVersion?: unknown } }) => {
        if ('suspendedAt' in data) target.suspendedAt = data.suspendedAt ?? null;
        return { count: 1 };
      }),
    },
    passkeyCredential: { deleteMany: vi.fn() },
    passkeyLoginTicket: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    webAuthnChallenge: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    session: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
    adminAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: 'member-id' }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, bootstrap, actor, target, rows };
}
type DB = ReturnType<typeof fixture>['db'];
const asDb = (db: DB) => db as unknown as PrismaClient;
const mutation = (db: DB, suspend: boolean, patch: Record<string, unknown> = {}) =>
  changeRegisteredUserSuspension({
    db: asDb(db),
    ownerId: 'owner-id',
    userId: 'member-id',
    suspend,
    now,
    sessionHash: 'a'.repeat(64),
    approvalToken: 'b'.repeat(43),
    ...patch,
  });

describe('Issue #1 6.11: registered user management is owner-only', () => {
  it('requires completed immutable bootstrap ID and a verified, active owner account', async () => {
    const { db } = fixture();
    await expect(requireRegisteredOwner(asDb(db), 'owner-id')).resolves.toBeUndefined();
    await expect(requireRegisteredOwner(asDb(db), 'member-id')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(requireRegisteredOwner(asDb(db), '')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const setup = fixture();
    setup.bootstrap.completedAt = null;
    await expect(requireRegisteredOwner(asDb(setup.db), 'owner-id')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const state of [{ emailVerified: null }, { suspendedAt: now }, { isPlaceholder: true }]) {
      const other = fixture();
      Object.assign(other.actor, state);
      await expect(requireRegisteredOwner(asDb(other.db), 'owner-id')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('excludes guest/placeholder records, paginates without duplicate boundary records, marks only real owner', async () => {
    const { db } = fixture();
    const data = await listOwnerRegisteredUsers(asDb(db), 'owner-id', {
      limit: 2,
      status: 'all',
      sortBy: 'createdAt',
      sortDirection: 'desc',
      search: 'mail.ru',
      cursor: 'old-row',
    });
    expect(data.users).toHaveLength(2);
    expect(data.users[0]).toMatchObject({ isOwner: true, status: 'active' });
    expect(data.users[1]).toMatchObject({ isOwner: false, status: 'active' });
    expect(data.nextCursor).toBe('member-id');
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        skip: 1,
        cursor: { id: 'old-row' },
        where: {
          isPlaceholder: false,
          OR: [
            { name: { contains: 'mail.ru', mode: 'insensitive' } },
            { email: { contains: 'mail.ru', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });

  it('filters suspended and unverified pending members without ever treating placeholders as registered', async () => {
    for (const [status, where] of [
      ['active', { suspendedAt: null, emailVerified: { not: null } }],
      ['suspended', { suspendedAt: { not: null } }],
      ['pending', { suspendedAt: null, emailVerified: null }],
    ] as const) {
      const { db } = fixture();
      await listOwnerRegisteredUsers(asDb(db), 'owner-id', {
        limit: 20,
        status,
        sortBy: 'email',
        sortDirection: 'asc',
      });
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isPlaceholder: false, ...where },
        }),
      );
    }
  });

  it('owner blocks a member once, invalidates old sessions and tickets but preserves Passkeys and data', async () => {
    const { db, target } = fixture();
    expect(await mutation(db, true)).toEqual({ suspended: true, userId: 'member-id' });
    expect(target.suspendedAt).toEqual(now);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'member-id');
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'member-id', isPlaceholder: false, suspendedAt: null },
      data: { suspendedAt: now },
    });
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'member-id' },
      data: { sessionSecurityVersion: { increment: 1 } },
    });
    expect(db.passkeyLoginTicket.deleteMany).toHaveBeenCalledWith({ where: { userId: 'member-id' } });
    expect(db.webAuthnChallenge.deleteMany).toHaveBeenCalledWith({ where: { userId: 'member-id' } });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'member-id' } });
    expect(db.passkeyCredential.deleteMany).not.toHaveBeenCalled();
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'owner-id',
        action: 'USER_SUSPENDED',
        targetId: 'member-id',
        metadata: { email: 'member@mail.ru', source: 'owner-admin-users' },
      },
    });
  });

  it('unblocks only the chosen member and audits, without reviving previously revoked JWTs', async () => {
    const { db, target } = fixture();
    target.suspendedAt = now;
    expect(await mutation(db, false)).toEqual({ suspended: false, userId: 'member-id' });
    expect(target.suspendedAt).toBeNull();
    expect(db.passkeyLoginTicket.deleteMany).not.toHaveBeenCalled();
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'owner-id',
        action: 'USER_UNSUSPENDED',
        targetId: 'member-id',
        metadata: { email: 'member@mail.ru', source: 'owner-admin-users' },
      },
    });
  });

  it('forbids self-block, any other owner, an incomplete bootstrap or a placeholder target', async () => {
    const self = fixture();
    await expect(mutation(self.db, true, { userId: 'owner-id' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(self.db.$transaction).not.toHaveBeenCalled();
    const wrong = fixture();
    await expect(mutation(wrong.db, true, { ownerId: 'member-id' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(wrong.db.user.updateMany).not.toHaveBeenCalled();
    const other = fixture();
    other.bootstrap.completedAt = null;
    await expect(mutation(other.db, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const placeholder = fixture();
    placeholder.target.isPlaceholder = true;
    await expect(mutation(placeholder.db, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects replayed suspension/unblock and missing or raced database target', async () => {
    const repeated = fixture();
    repeated.target.suspendedAt = now;
    await expect(mutation(repeated.db, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repeated.db.adminAuditLog.create).not.toHaveBeenCalled();
    const missing = fixture();
    missing.db.user.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(mutation(missing.db, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(missing.db.session.deleteMany).not.toHaveBeenCalled();
  });
});

describe('Issue 6.12.4.2: WebAuthn proof is mandatory and atomic for user suspension', () => {
  it('does not mutate or audit without a proof or valid owner/session', async () => {
    const { db, target } = fixture();
    for (const patch of [{ approvalToken: '' }, { sessionHash: '' }]) {
      await expect(mutation(db, true, patch)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.adminAuditLog.create).not.toHaveBeenCalled();
    expect(target.suspendedAt).toBeNull();
  });

  it('consumes the exact action, target, session proof between row locks and mutation', async () => {
    const { db } = fixture();
    vi.mocked(consumeOwnerPasskeyActionProof).mockClear();
    await mutation(db, true);
    expect(db.$queryRawUnsafe.mock.calls.slice(0, 2)).toEqual([
      ['SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'owner-id'],
      ['SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'member-id'],
    ]);
    expect(consumeOwnerPasskeyActionProof).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        userId: 'owner-id',
        targetId: 'member-id',
        action: 'USER_SUSPEND',
        sessionHash: 'a'.repeat(64),
        approvalToken: 'b'.repeat(43),
      }),
    );
    // One status update plus one sessionSecurityVersion bump during JWT revocation.
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'member-id', isPlaceholder: false, suspendedAt: null },
        data: { suspendedAt: now },
      }),
    );
    const other = fixture();
    other.target.suspendedAt = now;
    vi.mocked(consumeOwnerPasskeyActionProof).mockClear();
    await mutation(other.db, false);
    expect(consumeOwnerPasskeyActionProof).toHaveBeenCalledWith(
      other.db,
      expect.objectContaining({
        action: 'USER_UNSUSPEND',
        targetId: 'member-id',
        userId: 'owner-id',
      }),
    );
  });

  it('fails closed if the atomic one-time proof is missing, replayed, another user, or another action', async () => {
    for (const reason of ['consumed', 'wrong action', 'wrong user', 'expired']) {
      const { db, target } = fixture();
      vi.mocked(consumeOwnerPasskeyActionProof).mockRejectedValueOnce(new Error(reason));
      await expect(mutation(db, true)).rejects.toThrow(reason);
      expect(db.user.updateMany).not.toHaveBeenCalled();
      expect(db.adminAuditLog.create).not.toHaveBeenCalled();
      expect(target.suspendedAt).toBeNull();
    }
  });
});
