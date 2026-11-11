import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import {
  beginPasskeyLogin,
  consumePasskeyLoginTicket,
  finishPasskeyLogin,
  PASSKEY_LOGIN_TICKET_TTL_MS,
} from './passkey-login';
import { hashWebAuthnBinding } from './webauthn-registration';

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

const now = new Date('2026-11-11T12:00:00.000Z');
const browserSecret = 'b'.repeat(43);
const otherBrowser = 'x'.repeat(43);
const challenge = 'c'.repeat(43);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const env = { NODE_ENV: 'production' };
const response = {
  id: 'registered-credential',
  rawId: 'registered-credential',
  type: 'public-key',
  response: {
    clientDataJSON: Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://billok.ru' }),
    ).toString('base64url'),
    authenticatorData: '',
    signature: '',
  },
} as AuthenticationResponseJSON;

function fixture() {
  const user = {
    id: 'verified-user',
    name: 'Анна',
    email: 'anna@example.ru',
    emailVerified: now,
    suspendedAt: null,
    image: null,
    locale: 'ru',
    passkeyCredentials: [{ id: 'credential-row' }],
  };
  const passkey = {
    id: 'credential-row',
    credentialId: response.id,
    publicKey: Buffer.from([1, 2, 3]),
    signCount: BigInt(3),
    revokedAt: null,
    transports: ['internal'],
    user,
  };
  const request = {
    id: 'challenge-1',
    purpose: 'LOGIN',
    userId: null,
    challengeHash: hash(challenge),
    bindingHash: hashWebAuthnBinding(browserSecret),
    usedAt: null,
    expiresAt: new Date(now.getTime() + 300_000),
  };
  const proof = {
    id: 'ticket-1',
    userId: user.id,
    tokenHash: '',
    consumedAt: null as Date | null,
    expiresAt: new Date(now.getTime() + 60_000),
  };
  const db = {
    webAuthnChallenge: {
      create: vi.fn().mockResolvedValue({ id: request.id }),
      findUnique: vi.fn().mockResolvedValue(request),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passkeyCredential: {
      findUnique: vi.fn().mockResolvedValue(passkey),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passkeyLoginTicket: {
      create: vi.fn().mockImplementation(async ({ data }) => {
        proof.tokenHash = data.tokenHash;
        return proof;
      }),
      findUnique: vi.fn().mockResolvedValue(proof),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: vi.fn().mockResolvedValue(user) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: passkey.id }]),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
  };
  return { db, user, passkey, request, proof };
}
const asDb = (db: ReturnType<typeof fixture>['db']) => db as unknown as PrismaClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(generateAuthenticationOptions).mockResolvedValue({
    challenge,
    timeout: 300_000,
    rpId: 'billok.ru',
    userVerification: 'required',
  });
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: {
      credentialID: response.id,
      newCounter: 4,
      userVerified: true,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      origin: 'https://billok.ru',
      rpID: 'billok.ru',
    },
  });
});

describe('Issue #1 6.3.2.2: browser-bound passkey authentication', () => {
  it('creates a discoverable, UV-required, five-minute challenge without email enumeration', async () => {
    const { db } = fixture();
    const result = await beginPasskeyLogin({
      db: asDb(db),
      bindingSecret: browserSecret,
      now,
      env,
    });
    expect(result.challenge).toBe(challenge);
    const args = vi.mocked(generateAuthenticationOptions).mock.calls[0]![0];
    expect(args).toMatchObject({ rpID: 'billok.ru', userVerification: 'required', timeout: 300_000 });
    expect(args.allowCredentials).toBeUndefined();
    expect(db.webAuthnChallenge.create).toHaveBeenCalledWith({
      data: {
        challengeHash: hash(challenge),
        bindingHash: hashWebAuthnBinding(browserSecret),
        purpose: 'LOGIN',
        expiresAt: new Date('2026-11-11T12:05:00.000Z'),
      },
    });
    expect(JSON.stringify(db.webAuthnChallenge.create.mock.calls)).not.toContain(browserSecret);
    expect(JSON.stringify(db.webAuthnChallenge.create.mock.calls)).not.toContain(challenge);
  });

  it.each([
    ['different browser', { bindingHash: hashWebAuthnBinding(otherBrowser) }],
    ['expired challenge', { expiresAt: now }],
    ['already consumed', { usedAt: now }],
    ['registration-purpose challenge', { purpose: 'REGISTER' }],
  ])('refuses a %s without verifying a signature', async (_label, patch) => {
    const { db, request } = fixture();
    Object.assign(request, patch);
    await expect(
      finishPasskeyLogin({
        db: asDb(db),
        bindingSecret: browserSecret,
        response,
        now,
        env,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('rejects revoked, unverified or suspended key owners before generating a session proof', async () => {
    for (const patch of [
      { revokedAt: now },
      { user: { emailVerified: null, suspendedAt: null } },
      { user: { emailVerified: now, suspendedAt: now } },
    ]) {
      const { db, passkey } = fixture();
      Object.assign(passkey, patch);
      await expect(
        finishPasskeyLogin({
          db: asDb(db),
          bindingSecret: browserSecret,
          response,
          now,
          env,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('verifies exact origin/RP ID, presence and UV, atomically consumes challenge and issues one ticket', async () => {
    const { db, passkey, request } = fixture();
    const result = await finishPasskeyLogin({
      db: asDb(db),
      bindingSecret: browserSecret,
      response,
      now,
      env,
    });
    expect(result.loginTicket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const verifyOpts = vi.mocked(verifyAuthenticationResponse).mock.calls[0]![0];
    expect(verifyOpts).toMatchObject({
      expectedOrigin: 'https://billok.ru',
      expectedRPID: 'billok.ru',
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 3,
        transports: ['internal'],
      },
    });
    expect(typeof verifyOpts.expectedChallenge).toBe('function');
    if (typeof verifyOpts.expectedChallenge !== 'function') throw new Error('Challenge verifier missing');
    expect(await verifyOpts.expectedChallenge(challenge)).toBe(true);
    expect(await verifyOpts.expectedChallenge('q'.repeat(43))).toBe(false);
    expect(db.webAuthnChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        id: request.id,
        challengeHash: request.challengeHash,
        bindingHash: request.bindingHash,
        purpose: 'LOGIN',
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    expect(db.passkeyCredential.updateMany).toHaveBeenCalledWith({
      where: { id: passkey.id, revokedAt: null, signCount: BigInt(3) },
      data: expect.objectContaining({ signCount: BigInt(4), lastUsedAt: now }),
    });
    expect(db.passkeyLoginTicket.create).toHaveBeenCalledWith({
      data: {
        tokenHash: hash(result.loginTicket),
        userId: 'verified-user',
        expiresAt: new Date(now.getTime() + PASSKEY_LOGIN_TICKET_TTL_MS),
      },
    });
    expect(JSON.stringify(db.passkeyLoginTicket.create.mock.calls)).not.toContain(result.loginTicket);
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT id FROM "PasskeyCredential" WHERE id = $1 FOR UPDATE',
      passkey.id,
    );
  });

  it('fails a non-increasing signature counter, invalid UV, and any failed verification', async () => {
    for (const verification of [
      { verified: false, authenticationInfo: { userVerified: true, credentialID: response.id, newCounter: 4 } },
      { verified: true, authenticationInfo: { userVerified: false, credentialID: response.id, newCounter: 4 } },
      { verified: true, authenticationInfo: { userVerified: true, credentialID: response.id, newCounter: 3 } },
      { verified: true, authenticationInfo: { userVerified: true, credentialID: 'other-key', newCounter: 4 } },
    ]) {
      const { db } = fixture();
      vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce(
        verification as Awaited<ReturnType<typeof verifyAuthenticationResponse>>,
      );
      await expect(
        finishPasskeyLogin({
          db: asDb(db),
          bindingSecret: browserSecret,
          response,
          now,
          env,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.passkeyLoginTicket.create).not.toHaveBeenCalled();
    }
  });

  it('does not create a ticket if a competing request consumes the challenge', async () => {
    const { db } = fixture();
    db.webAuthnChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      finishPasskeyLogin({
        db: asDb(db),
        bindingSecret: browserSecret,
        response,
        now,
        env,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyLoginTicket.create).not.toHaveBeenCalled();
  });

  it('refuses missing or expired or reused tickets, and never creates a session without a valid key', async () => {
    const { db, proof, user } = fixture();
    expect(await consumePasskeyLoginTicket({ db: asDb(db), token: 'invalid', now })).toBeNull();
    const validTicket = 'z'.repeat(43);
    proof.tokenHash = hash(validTicket);
    expect(await consumePasskeyLoginTicket({ db: asDb(db), token: validTicket, now })).toMatchObject({
      id: user.id,
      email: user.email,
      locale: 'ru',
    });
    expect(db.passkeyLoginTicket.updateMany).toHaveBeenCalledWith({
      where: {
        id: proof.id,
        tokenHash: hash(validTicket),
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    db.passkeyLoginTicket.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await consumePasskeyLoginTicket({ db: asDb(db), token: validTicket, now })).toBeNull();
    proof.consumedAt = now;
    expect(await consumePasskeyLoginTicket({ db: asDb(db), token: validTicket, now })).toBeNull();
    proof.consumedAt = null;
    proof.expiresAt = now;
    expect(await consumePasskeyLoginTicket({ db: asDb(db), token: validTicket, now })).toBeNull();
    proof.expiresAt = new Date(now.getTime() + 60_000);
    db.user.findUnique.mockResolvedValueOnce({ ...user, suspendedAt: now });
    expect(await consumePasskeyLoginTicket({ db: asDb(db), token: validTicket, now })).toBeNull();
  });

  it('supports zero-only multi-device counters, but only with a unique challenge', async () => {
    const { db, passkey } = fixture();
    passkey.signCount = BigInt(0);
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        credentialID: response.id,
        newCounter: 0,
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        origin: 'https://billok.ru',
        rpID: 'billok.ru',
      },
    });
    expect(
      (
        await finishPasskeyLogin({
          db: asDb(db),
          bindingSecret: browserSecret,
          response,
          now,
          env,
        })
      ).loginTicket,
    ).toHaveLength(43);
    expect(db.webAuthnChallenge.updateMany).toHaveBeenCalledTimes(1);
  });
});
