import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { normalizeOwnerPasskeyLabel, renameOwnerPasskey, revokeApprovedOwnerPasskey } from './owner-passkey-management';

const now = new Date('2026-11-12T12:00:00Z');
const sessionHash = createHash('sha256').update('session-owner-A').digest('hex');
const token = 'p'.repeat(43);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function fixture(count = 3, action: 'RENAME' | 'REVOKE' = 'RENAME') {
  const user = {
    id: 'owner',
    emailVerified: now,
    suspendedAt: null as Date | null,
    isPlaceholder: false,
    sessionSecurityVersion: 2,
  };
  const owner = { userId: 'owner', completedAt: now as Date | null };
  const keys = [
    { id: 'key-1', userId: 'owner', label: 'Старое имя', revokedAt: null as Date | null, credentialId: 'cred-1' },
    { id: 'key-2', userId: 'owner', label: 'Сохраняемый', revokedAt: null as Date | null, credentialId: 'cred-2' },
    { id: 'key-3', userId: 'owner', label: 'Резервный', revokedAt: null as Date | null, credentialId: 'cred-3' },
  ].slice(0, count);
  const proof = {
    id: 'proof-1',
    userId: 'owner',
    tokenHash: hash(token),
    action,
    targetCredentialRowId: 'key-1',
    signerCredentialRowId: 'key-2',
    sessionBindingHash: sessionHash,
    sessionSecurityVersion: 2,
    consumedAt: null as Date | null,
    expiresAt: new Date(now.getTime() + 120_000),
  };
  const db = {
    ownerBootstrap: { findUnique: vi.fn(async () => owner) },
    user: {
      findUnique: vi.fn(async () => user),
      updateMany: vi.fn(async () => {
        user.sessionSecurityVersion++;
        return { count: 1 };
      }),
    },
    passkeyCredential: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => keys.find((key) => key.id === where.id) ?? null,
      ),
      findMany: vi.fn(async () => keys.filter((key) => !key.revokedAt)),
      count: vi.fn(async () => keys.filter((key) => !key.revokedAt).length),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; userId: string; revokedAt: null };
          data: { label?: string; revokedAt?: Date };
        }) => {
          const key = keys.find((entry) => entry.id === where.id && entry.userId === where.userId && !entry.revokedAt);
          if (!key) return { count: 0 };
          if (data.label !== undefined) key.label = data.label;
          if (data.revokedAt) key.revokedAt = data.revokedAt;
          return { count: 1 };
        },
      ),
    },
    ownerPasskeyActionProof: {
      findUnique: vi.fn(async () => proof),
      updateMany: vi.fn(async () => {
        if (proof.consumedAt) return { count: 0 };
        proof.consumedAt = now;
        return { count: 1 };
      }),
    },
    adminAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    webAuthnChallenge: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    passkeyLoginTicket: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    session: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: 'owner' }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, keys, proof, user, owner };
}
const asDb = (db: ReturnType<typeof fixture>['db']) => db as unknown as PrismaClient;
const rename = (db: ReturnType<typeof fixture>['db'], overrides: Record<string, unknown> = {}) =>
  renameOwnerPasskey({
    db: asDb(db),
    userId: 'owner',
    sessionHash,
    targetId: 'key-1',
    approvalToken: token,
    label: '  Телефон   ',
    now,
    ...overrides,
  });
const revoke = (db: ReturnType<typeof fixture>['db'], overrides: Record<string, unknown> = {}) =>
  revokeApprovedOwnerPasskey({
    db: asDb(db),
    userId: 'owner',
    sessionHash,
    targetId: 'key-1',
    approvalToken: token,
    now,
    ...overrides,
  });

describe('Issue #1 6.10.2.4: targeted signed Passkey management', () => {
  it('normalizes 1–40 character labels, rejecting blanks, control chars, bidi tricks and overflow', () => {
    expect(normalizeOwnerPasskeyLabel('  Galaxy S23  ')).toBe('Galaxy S23');
    expect(normalizeOwnerPasskeyLabel('📱'.repeat(40))).toBe('📱'.repeat(40));
    for (const label of ['', '   ', 'a'.repeat(41), 'Ключ\u0000', 'evil\u202evalue', 42]) {
      expect(() => normalizeOwnerPasskeyLabel(label)).toThrow();
    }
  });

  it('renames only the selected owner label; consumes matching proof and audits without changing sessions', async () => {
    const { db, keys } = fixture();
    expect(await rename(db)).toEqual({ renamed: true, label: 'Телефон' });
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'owner');
    expect(keys.map((key) => key.label)).toEqual(['Телефон', 'Сохраняемый', 'Резервный']);
    expect(db.ownerPasskeyActionProof.updateMany).toHaveBeenCalledTimes(1);
    expect(db.passkeyCredential.updateMany).toHaveBeenCalledWith({
      where: { id: 'key-1', userId: 'owner', revokedAt: null },
      data: { label: 'Телефон' },
    });
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'owner',
        action: 'OWNER_PASSKEY_RENAMED',
        metadata: { credentialRowId: 'key-1', labelChanged: true },
      },
    });
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.passkeyLoginTicket.deleteMany).not.toHaveBeenCalled();
    expect(db.session.deleteMany).not.toHaveBeenCalled();
  });

  it('denies an unsigned, expired, replayed or wrong-operation rename proof', async () => {
    for (const modification of [
      { action: 'REVOKE' },
      { consumedAt: now },
      { expiresAt: now },
      { sessionBindingHash: hash('another session') },
      { userId: 'stranger' },
      { targetCredentialRowId: 'key-2' },
    ]) {
      const { db, proof } = fixture();
      Object.assign(proof, modification);
      await expect(rename(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.passkeyCredential.updateMany).not.toHaveBeenCalled();
      expect(db.adminAuditLog.create).not.toHaveBeenCalled();
    }
    const { db } = fixture();
    await expect(rename(db, { approvalToken: 'invalid' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.updateMany).not.toHaveBeenCalled();
  });

  it('denies a foreign target, revoked target, unconfirmed owner and invalid label', async () => {
    const other = fixture();
    other.keys[0]!.userId = 'stranger';
    await expect(rename(other.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(other.db.ownerPasskeyActionProof.updateMany).not.toHaveBeenCalled();
    const revoked = fixture();
    revoked.keys[0]!.revokedAt = now;
    await expect(rename(revoked.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const unfinished = fixture();
    unfinished.owner.completedAt = null;
    await expect(rename(unfinished.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(unfinished.db.passkeyCredential.updateMany).not.toHaveBeenCalled();
    const invalid = fixture();
    await expect(rename(invalid.db, { label: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(invalid.db.$transaction).not.toHaveBeenCalled();
  });

  it('blocks competing rename consumers, even with an authentic signed approval', async () => {
    const { db } = fixture();
    db.ownerPasskeyActionProof.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(rename(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.updateMany).not.toHaveBeenCalled();
  });

  it('revokes ONLY selected key with fresh proof, invalidates all old sessions and audits', async () => {
    const { db, keys, user } = fixture(3, 'REVOKE');
    expect(await revoke(db)).toEqual({ revoked: true, activeRemaining: 2 });
    expect(keys[0]!.revokedAt).toEqual(now);
    expect(keys[1]!.revokedAt).toBeNull();
    expect(keys[2]!.revokedAt).toBeNull();
    expect(user.sessionSecurityVersion).toBe(3);
    expect(db.passkeyCredential.updateMany).toHaveBeenCalledWith({
      where: { id: 'key-1', userId: 'owner', revokedAt: null },
      data: { revokedAt: now },
    });
    expect(db.webAuthnChallenge.deleteMany).toHaveBeenCalledWith({ where: { userId: 'owner' } });
    expect(db.passkeyLoginTicket.deleteMany).toHaveBeenCalledWith({ where: { userId: 'owner' } });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'owner' } });
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'owner',
        action: 'OWNER_PASSKEY_REVOKED',
        metadata: {
          revokedCredentialRowId: 'key-1',
          activeRemaining: 2,
          method: 'fresh-signed-owner-approval',
          previousSessionsRevoked: true,
        },
      },
    });
  });

  it('denies last-key revocation, arbitrary other owner or unrelated key', async () => {
    const single = fixture(1, 'REVOKE');
    await expect(revoke(single.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(single.db.passkeyCredential.updateMany).not.toHaveBeenCalled();
    const foreign = fixture(2, 'REVOKE');
    foreign.keys[0]!.userId = 'stranger';
    await expect(revoke(foreign.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const anonymous = fixture(2, 'REVOKE');
    await expect(revoke(anonymous.db, { userId: 'non-owner' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(anonymous.db.passkeyCredential.updateMany).not.toHaveBeenCalled();
  });

  it('rejects replay/expired/wrong-target and stolen-signer approval for revocation', async () => {
    for (const patch of [
      { action: 'RENAME' },
      { consumedAt: now },
      { expiresAt: now },
      { targetCredentialRowId: 'key-2' },
      { sessionSecurityVersion: 999 },
      { signerCredentialRowId: 'key-1' },
      { signerCredentialRowId: 'not-owned' },
    ]) {
      const { db, proof } = fixture(2, 'REVOKE');
      Object.assign(proof, patch);
      await expect(revoke(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.passkeyCredential.updateMany).not.toHaveBeenCalled();
      expect(db.user.updateMany).not.toHaveBeenCalled();
    }
  });

  it('blocks race in proof consumption or key update before session invalidation', async () => {
    const proofLost = fixture(2, 'REVOKE');
    proofLost.db.ownerPasskeyActionProof.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(revoke(proofLost.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(proofLost.db.passkeyCredential.updateMany).not.toHaveBeenCalled();
    const keyLost = fixture(2, 'REVOKE');
    keyLost.db.passkeyCredential.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(revoke(keyLost.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(keyLost.db.user.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a second attempt after the same signed proof is consumed', async () => {
    const { db } = fixture(2, 'REVOKE');
    await revoke(db);
    await expect(revoke(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.updateMany).toHaveBeenCalledTimes(1);
  });
});
