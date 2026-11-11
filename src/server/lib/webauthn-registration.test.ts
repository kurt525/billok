import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import {
  beginFirstPasskeyRegistration,
  finishFirstPasskeyRegistration,
  hashWebAuthnBinding,
  newWebAuthnBindingSecret,
} from './webauthn-registration';

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

const secret = 'b'.repeat(43);
const otherSecret = 'c'.repeat(43);
const challenge = 'q'.repeat(43);
const now = new Date('2026-11-11T09:00:00Z');
const env = { NODE_ENV: 'production' };
const user = {
  id: 'user-1',
  email: 'person@mail.ru',
  name: 'Участник',
  emailVerified: now,
  registrationEmailVerificationRequired: true,
  suspendedAt: null,
  webAuthnUserHandle: null,
  passkeyCredentials: [],
};
const response = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  response: {
    clientDataJSON: Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge, origin: 'https://billok.ru' }),
    ).toString('base64url'),
    attestationObject: 'cbor',
  },
} as RegistrationResponseJSON;

function fakeDb() {
  const entry = {
    id: 'challenge-1',
    userId: user.id,
    purpose: 'REGISTER',
    challengeHash: '',
    bindingHash: hashWebAuthnBinding(secret),
    usedAt: null as Date | null,
    expiresAt: new Date(now.getTime() + 300_000),
  };
  const db = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce({ webAuthnUserHandle: 'h'.repeat(43) }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    webAuthnChallenge: {
      create: vi.fn().mockImplementation(async ({ data }) => {
        entry.challengeHash = data.challengeHash;
        return { id: entry.id };
      }),
      findUnique: vi.fn().mockImplementation(async () => entry),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passkeyCredential: { create: vi.fn().mockResolvedValue({ id: 'credential-1' }) },
    ownerBootstrap: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    adminAuditLog: { create: vi.fn().mockResolvedValue({ id: 'owner-audit-1' }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: user.id }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, entry };
}

const requireDb = (db: ReturnType<typeof fakeDb>['db']) => db as unknown as PrismaClient;

describe('Issue #1 6.3.2: first WebAuthn credential requires confirmed email and a signed attestation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(generateRegistrationOptions).mockResolvedValue({
      challenge,
      rp: { id: 'billok.ru', name: 'BillOK' },
      user: { id: 'abc', name: 'person@mail.ru', displayName: 'Участник' },
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
          id: 'credential-1',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
      },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
  });

  it('saves only hashes for a five-minute, browser-bound, verified-account challenge', async () => {
    const { db } = fakeDb();
    const result = await beginFirstPasskeyRegistration({
      db: requireDb(db),
      userId: user.id,
      bindingSecret: secret,
      env,
      now,
    });
    expect(result.challenge).toBe(challenge);
    const saved = db.webAuthnChallenge.create.mock.calls[0]![0].data;
    expect(saved.purpose).toBe('REGISTER');
    expect(saved.userId).toBe(user.id);
    expect(saved.bindingHash).toBe(hashWebAuthnBinding(secret));
    expect(saved.challengeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.expiresAt.toISOString()).toBe('2026-11-11T09:05:00.000Z');
    expect(JSON.stringify(saved)).not.toContain(challenge);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: user.id, webAuthnUserHandle: null },
      data: { webAuthnUserHandle: expect.any(String) },
    });
    expect(vi.mocked(generateRegistrationOptions).mock.calls[0]![0]).toMatchObject({
      rpID: 'billok.ru',
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
  });

  it('refuses unverified accounts and never creates an enrollment challenge', async () => {
    const { db } = fakeDb();
    db.user.findUnique.mockReset().mockResolvedValue({ ...user, emailVerified: null });
    await expect(
      beginFirstPasskeyRegistration({ db: requireDb(db), userId: user.id, bindingSecret: secret, env }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
  });

  it('refuses wrong browser, expired or previously consumed challenges before verifying attestation', async () => {
    for (const patch of [
      { bindingHash: hashWebAuthnBinding(otherSecret) },
      { usedAt: now },
      { expiresAt: now },
      { purpose: 'LOGIN' },
    ]) {
      const { db, entry } = fakeDb();
      Object.assign(entry, patch);
      await expect(
        finishFirstPasskeyRegistration({ db: requireDb(db), bindingSecret: secret, response, env, now }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(verifyRegistrationResponse).not.toHaveBeenCalled();
      expect(db.passkeyCredential.create).not.toHaveBeenCalled();
      vi.mocked(verifyRegistrationResponse).mockClear();
    }
  });

  it('verifies origin, RP ID, challenge and user verification before atomically saving the first credential', async () => {
    const { db, entry } = fakeDb();
    entry.challengeHash = createHash('sha256').update(challenge).digest('hex');
    db.user.findUnique.mockReset().mockResolvedValue({
      emailVerified: now,
      suspendedAt: null,
      passkeyCredentials: [],
    });
    const result = await finishFirstPasskeyRegistration({
      db: requireDb(db),
      bindingSecret: secret,
      response,
      env,
      now,
    });
    expect(result.registered).toBe(true);
    const opts = vi.mocked(verifyRegistrationResponse).mock.calls[0]![0];
    expect(opts.expectedOrigin).toBe('https://billok.ru');
    expect(opts.expectedRPID).toBe('billok.ru');
    expect(opts.requireUserVerification).toBe(true);
    expect(opts.requireUserPresence).toBe(true);
    expect(typeof opts.expectedChallenge).toBe('function');
    if (typeof opts.expectedChallenge !== 'function') throw new Error('Missing challenge verifier');
    expect(await opts.expectedChallenge(challenge)).toBe(true);
    expect(await opts.expectedChallenge('x'.repeat(43))).toBe(false);
    expect(db.webAuthnChallenge.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'challenge-1',
        usedAt: null,
        bindingHash: hashWebAuthnBinding(secret),
      }),
      data: { usedAt: now },
    });
    expect(db.passkeyCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: user.id,
        credentialId: 'credential-1',
        publicKey: Buffer.from([1, 2, 3]),
        signCount: BigInt(0),
        backedUp: true,
      }),
    });
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', user.id);
  });

  it('completes initial owner bootstrap with ONE verified Passkey in the same transaction', async () => {
    const { db, entry } = fakeDb();
    entry.challengeHash = createHash('sha256').update(challenge).digest('hex');
    db.user.findUnique.mockReset().mockResolvedValue({
      emailVerified: now,
      suspendedAt: null,
      passkeyCredentials: [],
    });
    db.ownerBootstrap.findUnique.mockResolvedValue({
      userId: user.id,
      completedAt: null,
    });
    const result = await finishFirstPasskeyRegistration({
      db: requireDb(db),
      bindingSecret: secret,
      response,
      env,
      now,
    });
    expect(result).toEqual({ registered: true });
    expect(db.ownerBootstrap.updateMany).toHaveBeenCalledWith({
      where: { id: 1, userId: user.id, completedAt: null },
      data: { completedAt: now },
    });
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: user.id,
        action: 'OWNER_BOOTSTRAP_COMPLETED',
        metadata: { activePasskeys: 1, optionalMaxPasskeys: 3 },
      },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('never completes owner bootstrap when registering an ordinary user', async () => {
    const { db, entry } = fakeDb();
    entry.challengeHash = createHash('sha256').update(challenge).digest('hex');
    db.user.findUnique.mockReset().mockResolvedValue({
      emailVerified: now,
      suspendedAt: null,
      passkeyCredentials: [],
    });
    db.ownerBootstrap.findUnique.mockResolvedValue({ userId: 'another-user', completedAt: null });
    await finishFirstPasskeyRegistration({ db: requireDb(db), bindingSecret: secret, response, env, now });
    expect(db.ownerBootstrap.updateMany).not.toHaveBeenCalled();
    expect(db.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('does not complete owner bootstrap when marking its singleton row loses a race', async () => {
    const { db, entry } = fakeDb();
    entry.challengeHash = createHash('sha256').update(challenge).digest('hex');
    db.user.findUnique.mockReset().mockResolvedValue({
      emailVerified: now,
      suspendedAt: null,
      passkeyCredentials: [],
    });
    db.ownerBootstrap.findUnique.mockResolvedValue({ userId: user.id, completedAt: null });
    db.ownerBootstrap.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      finishFirstPasskeyRegistration({ db: requireDb(db), bindingSecret: secret, response, env, now }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a losing concurrent challenge and rolls back the first-key write', async () => {
    const { db, entry } = fakeDb();
    entry.challengeHash = createHash('sha256').update(challenge).digest('hex');
    db.user.findUnique.mockReset().mockResolvedValue({
      emailVerified: now,
      suspendedAt: null,
      passkeyCredentials: [],
    });
    db.webAuthnChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      finishFirstPasskeyRegistration({
        db: requireDb(db),
        bindingSecret: secret,
        response,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.create).not.toHaveBeenCalled();
  });

  it('does not allow arbitrary short browser binding secrets', () => {
    expect(() => hashWebAuthnBinding('123')).toThrow();
    expect(newWebAuthnBindingSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
