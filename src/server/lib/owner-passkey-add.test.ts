import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { beginAdditionalOwnerPasskey, finishAdditionalOwnerPasskey } from './owner-passkey-add';
import { hashWebAuthnBinding } from './webauthn-registration';

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

const now = new Date('2026-11-12T12:00:00Z');
const secret = 'b'.repeat(43);
const approvalToken = 'a'.repeat(43);
const challenge = 'q'.repeat(43);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sessionHash = digest('authjs.session-token=owner-session');
const tokenHash = digest(approvalToken);
const bindingHash = hashWebAuthnBinding(secret);
const env = { NODE_ENV: 'production' };
const response = {
  id: 'new-owner-credential',
  rawId: 'new-owner-credential',
  type: 'public-key',
  response: {
    clientDataJSON: Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge,
        origin: 'https://billok.ru',
      }),
    ).toString('base64url'),
    attestationObject: 'cbor',
  },
} as RegistrationResponseJSON;

function fixture(keyCount = 1) {
  const owner = { userId: 'owner-id', completedAt: now as Date | null };
  const user = {
    id: 'owner-id',
    email: 'owner@mail.ru',
    name: 'Владелец',
    emailVerified: now as Date | null,
    suspendedAt: null as Date | null,
    isPlaceholder: false,
    webAuthnUserHandle: Buffer.alloc(32, 1).toString('base64url'),
    sessionSecurityVersion: 3,
  };
  const keys = [
    { id: 'existing-1', credentialId: 'original-1', transports: ['internal'], revokedAt: null },
    { id: 'existing-2', credentialId: 'original-2', transports: ['internal'], revokedAt: null },
    { id: 'existing-3', credentialId: 'original-3', transports: ['internal'], revokedAt: null },
  ].slice(0, keyCount);
  const proof = {
    id: 'approval-1',
    tokenHash,
    userId: 'owner-id',
    action: 'ADD',
    targetCredentialRowId: null as string | null,
    signerCredentialRowId: 'existing-1',
    sessionSecurityVersion: 3,
    sessionBindingHash: sessionHash,
    consumedAt: null as Date | null,
    expiresAt: new Date(now.getTime() + 120_000),
  };
  const challengeRow = {
    id: 'challenge-1',
    userId: 'owner-id',
    purpose: 'ADD_KEY',
    challengeHash: digest(challenge),
    bindingHash,
    sessionBindingHash: sessionHash,
    approvalProofTokenHash: tokenHash,
    usedAt: null as Date | null,
    expiresAt: new Date(now.getTime() + 300_000),
  };
  const db = {
    ownerPasskeyActionProof: {
      findUnique: vi.fn(async () => proof),
      updateMany: vi.fn(async () => {
        if (proof.consumedAt) return { count: 0 };
        proof.consumedAt = now;
        return { count: 1 };
      }),
    },
    ownerBootstrap: { findUnique: vi.fn(async () => owner) },
    user: { findUnique: vi.fn(async () => user) },
    passkeyCredential: {
      findMany: vi.fn(async () => keys),
      count: vi.fn(async () => keys.length),
      findUnique: vi.fn(async () => null as null | { id: string }),
      create: vi.fn(async () => ({ id: 'created-credential' })),
    },
    webAuthnChallenge: {
      create: vi.fn().mockResolvedValue({ id: 'challenge-1' }),
      findUnique: vi.fn(async () => challengeRow),
      updateMany: vi.fn(async () => {
        if (challengeRow.usedAt) return { count: 0 };
        challengeRow.usedAt = now;
        return { count: 1 };
      }),
    },
    adminAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: 'owner-id' }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, owner, user, keys, proof, challengeRow };
}
const asDb = (db: ReturnType<typeof fixture>['db']) => db as unknown as PrismaClient;
function begin(db: ReturnType<typeof fixture>['db'], overrides: Record<string, unknown> = {}) {
  return beginAdditionalOwnerPasskey({
    db: asDb(db),
    userId: 'owner-id',
    bindingSecret: secret,
    sessionHash,
    approvalToken,
    now,
    env,
    ...overrides,
  });
}
function finish(db: ReturnType<typeof fixture>['db'], overrides: Record<string, unknown> = {}) {
  return finishAdditionalOwnerPasskey({
    db: asDb(db),
    userId: 'owner-id',
    bindingSecret: secret,
    sessionHash,
    approvalToken,
    response,
    now,
    env,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateRegistrationOptions).mockResolvedValue({
    challenge,
    rp: { id: 'billok.ru', name: 'BillOK' },
    user: {
      id: 'user-handle',
      name: 'owner@mail.ru',
      displayName: 'Владелец',
    },
    pubKeyCredParams: [],
    timeout: 300_000,
  });
  vi.mocked(verifyRegistrationResponse).mockResolvedValue({
    verified: true,
    registrationInfo: {
      userVerified: true,
      aaguid: '00000000-0000-0000-0000-000000000000',
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      credentialType: 'public-key',
      fmt: 'none',
      attestationObject: new Uint8Array(),
      origin: 'https://billok.ru',
      credential: {
        id: 'new-owner-credential',
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ['internal'],
      },
    },
  } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
});

describe('Issue #1 6.10.2.3: independent owner key must consume signed ADD approval', () => {
  it('generates an independent challenge and excludes all existing keys for 1 or 2 active keys', async () => {
    for (const count of [1, 2]) {
      const { db } = fixture(count);
      expect(await begin(db)).toMatchObject({ challenge });
      expect(vi.mocked(generateRegistrationOptions).mock.lastCall?.[0]).toMatchObject({
        rpID: 'billok.ru',
        attestationType: 'none',
        timeout: 300_000,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: Array.from({ length: count }, (_, i) => ({ id: 'original-' + (i + 1) })),
      });
      expect(db.webAuthnChallenge.create).toHaveBeenCalledWith({
        data: {
          userId: 'owner-id',
          purpose: 'ADD_KEY',
          challengeHash: digest(challenge),
          bindingHash,
          sessionBindingHash: sessionHash,
          approvalProofTokenHash: tokenHash,
          expiresAt: new Date(now.getTime() + 300_000),
        },
      });
    }
  });

  it('blocks ordinary accounts, incomplete owner, suspended and placeholder before challenge creation', async () => {
    for (const patch of [
      { userId: 'stranger', completedAt: now },
      { userId: 'owner-id', completedAt: null },
    ]) {
      const { db, owner } = fixture();
      Object.assign(owner, patch);
      await expect(begin(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
    }
    for (const patch of [
      { emailVerified: null },
      { suspendedAt: now },
      { isPlaceholder: true },
      { webAuthnUserHandle: null },
    ]) {
      const { db, user } = fixture();
      Object.assign(user, patch);
      await expect(begin(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
    }
  });

  it('denies a fourth key, zero-key bypass, wrong owner and wrong approval action', async () => {
    for (const n of [0, 3]) {
      const { db } = fixture(n);
      await expect(begin(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
    }
    for (const patch of [
      { userId: 'other-id' },
      { action: 'RENAME' },
      { action: 'REVOKE' },
      { sessionBindingHash: digest('another JWT') },
      { consumedAt: now },
      { expiresAt: now },
      { targetCredentialRowId: 'existing-1' },
    ]) {
      const { db, proof } = fixture();
      Object.assign(proof, patch);
      await expect(begin(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
    }
  });

  it('rejects different browser, session, approval, expired or replayed registration challenge', async () => {
    for (const patch of [
      { purpose: 'REGISTER' },
      { usedAt: now },
      { expiresAt: now },
      { userId: 'another' },
      { bindingHash: digest('different device') },
      { sessionBindingHash: digest('another session') },
      { approvalProofTokenHash: digest('other ticket') },
    ]) {
      const { db, challengeRow } = fixture();
      Object.assign(challengeRow, patch);
      await expect(finish(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    }
    const { db } = fixture();
    await expect(finish(db, { approvalToken: 'c'.repeat(43) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('enforces actual signed origin, RP ID, UV, and exact challenge hash', async () => {
    const { db } = fixture();
    expect(await finish(db)).toEqual({ registered: true, activePasskeys: 2 });
    const checked = vi.mocked(verifyRegistrationResponse).mock.calls[0]![0];
    expect(checked).toMatchObject({
      expectedOrigin: 'https://billok.ru',
      expectedRPID: 'billok.ru',
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (typeof checked.expectedChallenge !== 'function') throw new Error('missing challenge validator');
    expect(await checked.expectedChallenge(challenge)).toBe(true);
    expect(await checked.expectedChallenge('z'.repeat(43))).toBe(false);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', 'owner-id');
    expect(db.ownerPasskeyActionProof.updateMany).toHaveBeenCalledOnce();
    expect(db.webAuthnChallenge.updateMany).toHaveBeenCalledOnce();
    expect(db.passkeyCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner-id',
        credentialId: 'new-owner-credential',
        publicKey: Buffer.from([1, 2, 3]),
        backedUp: true,
        signCount: BigInt(0),
      }),
    });
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: 'owner-id',
        action: 'OWNER_PASSKEY_ADDED',
        metadata: {
          credentialRowId: 'created-credential',
          activePasskeys: 2,
          method: 'existing-signed-passkey-approval',
        },
      },
    });
  });

  it('second owner key makes count 3, never 4, and never issues an Auth.js session', async () => {
    const { db } = fixture(2);
    expect(await finish(db)).toEqual({ registered: true, activePasskeys: 3 });
    expect(db.passkeyCredential.create).toHaveBeenCalledTimes(1);
    expect(db).not.toHaveProperty('passkeyLoginTicket.create');
  });

  it('no approval, revoked signer, changed session version, replayed proof cannot register', async () => {
    for (const modification of ['replay', 'signer-revoked', 'version', 'capacity'] as const) {
      const { db, proof, keys, user } = fixture();
      if (modification === 'replay') proof.consumedAt = now;
      if (modification === 'signer-revoked') keys.splice(0, 1);
      if (modification === 'version') user.sessionSecurityVersion++;
      if (modification === 'capacity') keys.push(...fixture(2).keys);
      await expect(finish(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.passkeyCredential.create).not.toHaveBeenCalled();
      vi.mocked(verifyRegistrationResponse).mockClear();
    }
  });

  it('rejects duplicate credential ID even if a different user owns the credential', async () => {
    const { db } = fixture();
    db.passkeyCredential.findUnique.mockResolvedValueOnce({ id: 'someone-elses-key' });
    await expect(finish(db)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.passkeyCredential.create).not.toHaveBeenCalled();
  });

  it('rejects a concurrent challenge/proof consumer before persisting new key', async () => {
    const challengeLost = fixture();
    challengeLost.db.webAuthnChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(finish(challengeLost.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(challengeLost.db.passkeyCredential.create).not.toHaveBeenCalled();
    const proofLost = fixture();
    proofLost.db.ownerPasskeyActionProof.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(finish(proofLost.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(proofLost.db.passkeyCredential.create).not.toHaveBeenCalled();
  });

  it('incorrect attestation or missing UV is rejected before any transaction', async () => {
    const badSignature = fixture();
    vi.mocked(verifyRegistrationResponse).mockRejectedValueOnce(new Error('wrong origin'));
    await expect(finish(badSignature.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const noUv = fixture();
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
      registrationInfo: { userVerified: false },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
    await expect(finish(noUv.db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(noUv.db.$transaction).not.toHaveBeenCalled();
  });
});
