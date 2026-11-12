import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { hashWebAuthnBinding } from './webauthn-registration';
import { beginOwnerPasskeyRevocation, finishOwnerPasskeyRevocation } from './owner-passkey-revocation';

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

const now = new Date('2026-11-12T11:30:00.000Z');
const secret = 'b'.repeat(43);
const challenge = 'c'.repeat(43);
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const env = { NODE_ENV: 'production' };
const signed: AuthenticationResponseJSON = {
  id: 'credential-keep',
  rawId: 'credential-keep',
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    clientDataJSON: Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin: 'https://billok.ru',
      }),
    ).toString('base64url'),
    authenticatorData: '',
    signature: '',
  },
};

function fixture(keyCount = 2) {
  const owner = { userId: 'owner-1', completedAt: now as Date | null };
  const user = { emailVerified: now, suspendedAt: null as Date | null, isPlaceholder: false };
  const credentials = [
    {
      id: 'key-lost',
      credentialId: 'credential-lost',
      transports: ['internal'],
      userId: 'owner-1',
      publicKey: Buffer.from([1, 2, 3]),
      signCount: BigInt(3),
      revokedAt: null as Date | null,
    },
    {
      id: 'key-keep',
      credentialId: 'credential-keep',
      transports: ['internal'],
      userId: 'owner-1',
      publicKey: Buffer.from([4, 5, 6]),
      signCount: BigInt(3),
      revokedAt: null as Date | null,
    },
    {
      id: 'key-third',
      credentialId: 'credential-third',
      transports: ['internal'],
      userId: 'owner-1',
      publicKey: Buffer.from([7, 8, 9]),
      signCount: BigInt(0),
      revokedAt: null as Date | null,
    },
  ].slice(0, keyCount);
  const challengeRow = {
    id: 'challenge-1',
    challengeHash: digest(challenge),
    bindingHash: hashWebAuthnBinding(secret),
    purpose: 'OWNER_REVOKE',
    userId: 'owner-1',
    targetCredentialRowId: 'key-lost',
    usedAt: null as Date | null,
    expiresAt: new Date(now.getTime() + 300_000),
  };
  const db = {
    ownerBootstrap: { findUnique: vi.fn(async () => owner) },
    user: {
      findUnique: vi.fn(async () => user),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passkeyCredential: {
      findMany: vi.fn(async () => credentials.filter((key) => !key.revokedAt)),
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; credentialId?: string } }) =>
          credentials.find((key) => key.id === where.id || key.credentialId === where.credentialId) ?? null,
      ),
      count: vi.fn(async () => credentials.filter((key) => !key.revokedAt).length),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; revokedAt?: null; signCount?: bigint };
          data: { revokedAt?: Date; signCount?: bigint };
        }) => {
          const item = credentials.find(
            (key) =>
              key.id === where.id &&
              !key.revokedAt &&
              (where.signCount === undefined || key.signCount === where.signCount),
          );
          if (!item) return { count: 0 };
          if (data.revokedAt) item.revokedAt = data.revokedAt;
          if (data.signCount !== undefined) item.signCount = data.signCount;
          return { count: 1 };
        },
      ),
    },
    webAuthnChallenge: {
      create: vi.fn().mockResolvedValue({ id: challengeRow.id }),
      findUnique: vi.fn(async () => challengeRow),
      updateMany: vi.fn(async () => {
        if (challengeRow.usedAt) return { count: 0 };
        challengeRow.usedAt = now;
        return { count: 1 };
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passkeyLoginTicket: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    session: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    adminAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: 'owner-1' }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, owner, user, credentials, challengeRow };
}

const asDb = (db: ReturnType<typeof fixture>['db']) => db as unknown as PrismaClient;
const begin = (db: ReturnType<typeof fixture>['db'], targetId = 'key-lost', ownerId = 'owner-1') =>
  beginOwnerPasskeyRevocation({ db: asDb(db), ownerId, targetId, bindingSecret: secret, env, now });
const finish = (db: ReturnType<typeof fixture>['db'], ownerId = 'owner-1', bindingSecret = secret, response = signed) =>
  finishOwnerPasskeyRevocation({ db: asDb(db), ownerId, bindingSecret, response, env, now });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateAuthenticationOptions).mockResolvedValue({
    challenge,
    rpId: 'billok.ru',
    timeout: 300_000,
    userVerification: 'required',
  });
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: {
      credentialID: signed.id,
      newCounter: 4,
      userVerified: true,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      origin: 'https://billok.ru',
      rpID: 'billok.ru',
    },
  });
});

describe('Issue #1 6.8.2.2: owner revokes one lost key with a DIFFERENT signed Passkey', () => {
  it('issues owner-bound, target-bound challenge allowing only surviving keys; never a login ticket', async () => {
    const { db } = fixture(3);
    expect(await begin(db)).toMatchObject({ challenge });
    expect(vi.mocked(generateAuthenticationOptions).mock.calls[0]![0]).toMatchObject({
      rpID: 'billok.ru',
      userVerification: 'required',
      timeout: 300_000,
      allowCredentials: [{ id: 'credential-keep' }, { id: 'credential-third' }],
    });
    expect(db.webAuthnChallenge.create).toHaveBeenCalledWith({
      data: {
        purpose: 'OWNER_REVOKE',
        userId: 'owner-1',
        targetCredentialRowId: 'key-lost',
        challengeHash: digest(challenge),
        bindingHash: hashWebAuthnBinding(secret),
        expiresAt: new Date(now.getTime() + 300_000),
      },
    });
    expect(db.passkeyLoginTicket).not.toHaveProperty('create');
  });

  it('never allows ordinary users, incomplete owner, missing or suspended accounts', async () => {
    for (const ownerStatus of [
      { userId: 'someone-else', completedAt: now },
      { userId: 'owner-1', completedAt: null },
    ]) {
      const { db, owner } = fixture();
      Object.assign(owner, ownerStatus);
      await expect(begin(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
    }
    for (const userStatus of [{ emailVerified: null }, { suspendedAt: now }, { isPlaceholder: true }]) {
      const { db, user } = fixture();
      Object.assign(user, userStatus);
      await expect(begin(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const { db } = fixture();
    await expect(begin(db, 'key-lost', 'unrelated-id')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('blocks revocation of the only active key or any unrecognized target', async () => {
    const solo = fixture(1);
    await expect(begin(solo.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = fixture(2);
    await expect(begin(other.db, 'not-my-key')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(other.db.webAuthnChallenge.create).not.toHaveBeenCalled();
  });

  it('refuses browser mismatch, expired/used challenge, wrong purpose and changed target', async () => {
    for (const patch of [
      { usedAt: now },
      { expiresAt: now },
      { purpose: 'LOGIN' },
      { userId: 'other' },
      { targetCredentialRowId: null },
      { bindingHash: hashWebAuthnBinding('x'.repeat(43)) },
    ]) {
      const { db, challengeRow } = fixture();
      Object.assign(challengeRow, patch);
      await expect(finish(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    }
  });

  it('refuses a lost credential signing its own revocation, a stranger or an already revoked signer', async () => {
    const lost = fixture();
    await expect(finish(lost.db, 'owner-1', secret, { ...signed, id: 'credential-lost' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const stranger = fixture();
    await expect(finish(stranger.db, 'owner-1', secret, { ...signed, id: 'not-ours' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const revoked = fixture();
    revoked.credentials[1]!.revokedAt = now;
    await expect(finish(revoked.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('checks the signed origin, exact RP ID, user verification and replay-safe counter', async () => {
    const { db } = fixture();
    await finish(db);
    const args = vi.mocked(verifyAuthenticationResponse).mock.calls[0]![0];
    expect(args).toMatchObject({
      expectedOrigin: 'https://billok.ru',
      expectedRPID: 'billok.ru',
      requireUserVerification: true,
      credential: { id: signed.id, publicKey: new Uint8Array([4, 5, 6]), counter: 3 },
    });
    if (typeof args.expectedChallenge !== 'function') throw new Error('Verifier not a challenge function');
    expect(await args.expectedChallenge(challenge)).toBe(true);
    expect(await args.expectedChallenge('z'.repeat(43))).toBe(false);
  });

  it('refuses wrong-origin attestation, missing UV and non-advancing hardware counters', async () => {
    const badOrigin = fixture();
    vi.mocked(verifyAuthenticationResponse).mockRejectedValueOnce(new Error('origin'));
    await expect(finish(badOrigin.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(badOrigin.db.webAuthnChallenge.updateMany).not.toHaveBeenCalled();
    for (const output of [
      { verified: true, authenticationInfo: { userVerified: false, credentialID: signed.id, newCounter: 4 } },
      { verified: true, authenticationInfo: { userVerified: true, credentialID: 'another', newCounter: 4 } },
      { verified: true, authenticationInfo: { userVerified: true, credentialID: signed.id, newCounter: 3 } },
    ]) {
      const { db } = fixture();
      vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce(
        output as Awaited<ReturnType<typeof verifyAuthenticationResponse>>,
      );
      await expect(finish(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.passkeyCredential.updateMany).not.toHaveBeenCalled();
    }
  });

  it('atomically revokes only the target, retains signer/third, invalidates JWTs and writes audit', async () => {
    const { db, credentials, challengeRow } = fixture(3);
    expect(await finish(db)).toEqual({ revoked: true, activeRemaining: 2 });
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'owner-1');
    expect(db.webAuthnChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        id: challengeRow.id,
        challengeHash: challengeRow.challengeHash,
        bindingHash: challengeRow.bindingHash,
        purpose: 'OWNER_REVOKE',
        userId: 'owner-1',
        targetCredentialRowId: 'key-lost',
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    expect(credentials[0]!.revokedAt).toEqual(now);
    expect(credentials[1]!.revokedAt).toBeNull();
    expect(credentials[2]!.revokedAt).toBeNull();
    expect(db.passkeyCredential.updateMany).toHaveBeenCalledTimes(2);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'owner-1' },
      data: { sessionSecurityVersion: { increment: 1 } },
    });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'owner-1' } });
    expect(db.passkeyLoginTicket.deleteMany).toHaveBeenCalledWith({ where: { userId: 'owner-1' } });
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'owner-1',
        action: 'OWNER_PASSKEY_REVOKED',
        metadata: {
          revokedCredentialRowId: 'key-lost',
          verifiedCredentialRowId: 'key-keep',
          activeRemaining: 2,
          previousSessionsRevoked: true,
        },
      },
    });
    expect(db.passkeyLoginTicket).not.toHaveProperty('create');
  });

  it('fails closed on a consumed challenge or competing target revocation', async () => {
    const consumed = fixture();
    consumed.db.webAuthnChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(finish(consumed.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(consumed.db.passkeyCredential.updateMany).not.toHaveBeenCalled();
    const targetGone = fixture();
    targetGone.credentials[0]!.revokedAt = now;
    await expect(finish(targetGone.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(targetGone.db.user.updateMany).not.toHaveBeenCalled();
    const last = fixture();
    last.db.passkeyCredential.count.mockResolvedValueOnce(1);
    await expect(finish(last.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(last.db.passkeyCredential.updateMany).not.toHaveBeenCalled();
  });

  it('refuses replay of the same signed challenge after a successful revoke', async () => {
    const { db } = fixture();
    await finish(db);
    await expect(finish(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.updateMany).toHaveBeenCalledTimes(2);
  });
});
