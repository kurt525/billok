import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { beginOwnerBackupPasskey, finishOwnerBackupPasskey } from './owner-backup-passkey';
import { hashWebAuthnBinding } from './webauthn-registration';

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));
const now = new Date('2026-11-11T12:00:00.000Z');
const secret = 'b'.repeat(43);
const challenge = 'c'.repeat(43);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const newCredentialId = 'new-backup-key';
const response = {
  id: newCredentialId,
  rawId: newCredentialId,
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
const env = { NODE_ENV: 'production' };
const user = {
  email: 'owner@example.ru',
  name: 'Владелец',
  emailVerified: now,
  suspendedAt: null,
  webAuthnUserHandle: 'x'.repeat(43),
  passkeyCredentials: [{ id: 'first', credentialId: 'first-key', transports: ['internal'] }],
};

function fixture() {
  const owner = { id: 1, userId: 'owner-1', completedAt: null as Date | null };
  const request = {
    id: 'challenge-1',
    userId: owner.userId,
    purpose: 'ADD_KEY',
    challengeHash: digest(challenge),
    bindingHash: hashWebAuthnBinding(secret),
    usedAt: null as Date | null,
    expiresAt: new Date(now.getTime() + 300_000),
  };
  const db = {
    ownerBootstrap: {
      findUnique: vi.fn().mockImplementation(async () => owner),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: vi.fn().mockImplementation(async () => user) },
    webAuthnChallenge: {
      create: vi.fn().mockResolvedValue({ id: request.id }),
      findUnique: vi.fn().mockImplementation(async () => request),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passkeyCredential: { create: vi.fn().mockResolvedValue({ id: 'backup-key' }) },
    adminAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: 'owner-1' }]),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
  };
  return { db, owner, request };
}
const asDb = (db: ReturnType<typeof fixture>['db']) => db as unknown as PrismaClient;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(generateRegistrationOptions).mockResolvedValue({
    challenge,
    rp: { id: 'billok.ru', name: 'BillOK' },
    user: { id: 'opaque', name: user.email, displayName: user.name },
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
      credential: { id: newCredentialId, publicKey: new Uint8Array([1, 2]), counter: 0, transports: ['internal'] },
    },
  } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
});

describe('Issue #1 6.3.2.2.2: only the signed-in owner can add a different second key', () => {
  it('refuses other users and completed owner setup before minting a challenge', async () => {
    const { db, owner } = fixture();
    await expect(
      beginOwnerBackupPasskey({
        db: asDb(db),
        userId: 'attacker',
        bindingSecret: secret,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    owner.completedAt = now;
    await expect(
      beginOwnerBackupPasskey({
        db: asDb(db),
        userId: owner.userId,
        bindingSecret: secret,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
  });

  it('excludes the primary credential and requires UV with a five-minute browser-bound challenge', async () => {
    const { db } = fixture();
    await beginOwnerBackupPasskey({
      db: asDb(db),
      userId: 'owner-1',
      bindingSecret: secret,
      env,
      now,
    });
    const options = vi.mocked(generateRegistrationOptions).mock.calls[0]![0];
    expect(options).toMatchObject({
      rpID: 'billok.ru',
      attestationType: 'none',
      excludeCredentials: [{ id: 'first-key', transports: ['internal'] }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    expect(db.webAuthnChallenge.create).toHaveBeenCalledWith({
      data: {
        userId: 'owner-1',
        purpose: 'ADD_KEY',
        challengeHash: digest(challenge),
        bindingHash: hashWebAuthnBinding(secret),
        expiresAt: new Date(now.getTime() + 300_000),
      },
    });
  });

  it('refuses an expired, consumed, or another-browser challenge before attestation', async () => {
    for (const patch of [
      { bindingHash: hashWebAuthnBinding('x'.repeat(43)) },
      { usedAt: now },
      { expiresAt: now },
      { purpose: 'LOGIN' },
      { userId: 'other-user' },
    ]) {
      const { db, request } = fixture();
      Object.assign(request, patch);
      await expect(
        finishOwnerBackupPasskey({
          db: asDb(db),
          userId: 'owner-1',
          bindingSecret: secret,
          response,
          env,
          now,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    }
  });

  it('atomically saves a unique second key, completes bootstrap and logs without secrets', async () => {
    const { db } = fixture();
    await expect(
      finishOwnerBackupPasskey({
        db: asDb(db),
        userId: 'owner-1',
        bindingSecret: secret,
        response,
        env,
        now,
      }),
    ).resolves.toEqual({ completed: true });
    expect(verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: 'https://billok.ru',
        expectedRPID: 'billok.ru',
        requireUserVerification: true,
        requireUserPresence: true,
      }),
    );
    expect(db.passkeyCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner-1',
        credentialId: newCredentialId,
        publicKey: Buffer.from([1, 2]),
        label: 'Резервный ключ владельца',
      }),
    });
    expect(db.ownerBootstrap.updateMany).toHaveBeenCalledWith({
      where: { id: 1, userId: 'owner-1', completedAt: null },
      data: { completedAt: now },
    });
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'owner-1', action: 'OWNER_BOOTSTRAP_COMPLETED', metadata: { activePasskeys: 2 } },
    });
    expect(JSON.stringify(db.adminAuditLog.create.mock.calls)).not.toContain(challenge);
  });

  it('cannot register the first key again, or complete if challenge was already consumed', async () => {
    const { db } = fixture();
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        userVerified: true,
        credential: { id: 'first-key', publicKey: new Uint8Array([1]), counter: 0 },
      },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
    await expect(
      finishOwnerBackupPasskey({
        db: asDb(db),
        userId: 'owner-1',
        bindingSecret: secret,
        response,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.create).not.toHaveBeenCalled();
    db.webAuthnChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      finishOwnerBackupPasskey({
        db: asDb(db),
        userId: 'owner-1',
        bindingSecret: secret,
        response,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
