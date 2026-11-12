import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { sendRussianPasskeyRecoveryEmail } from './passkey-recovery-email';
import { hashEmailVerificationToken } from './email-verification-token';
import { hashWebAuthnBinding } from './webauthn-registration';
import {
  beginPasskeyRecovery,
  finishPasskeyRecovery,
  requestPasskeyRecovery,
  RECOVERY_EMAIL_LIMIT_PER_HOUR,
  RECOVERY_TOKEN_TTL_MS,
} from './passkey-email-recovery';

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));
vi.mock('./passkey-recovery-email', () => ({ sendRussianPasskeyRecoveryEmail: vi.fn() }));

const now = new Date('2026-11-12T10:00:00.000Z');
const validToken = 't'.repeat(43);
const secret = 'b'.repeat(43);
const challengeValue = 'q'.repeat(43);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const env = {
  NODE_ENV: 'production',
  NEXTAUTH_URL: 'https://billok.ru',
  EMAIL_SERVER_HOST: 'smtp.example.ru',
  EMAIL_SERVER_PORT: '465',
  EMAIL_SERVER_USER: 'noreply@billok.ru',
  EMAIL_SERVER_PASSWORD: 'not-real',
};
const account = {
  id: 'user-1',
  email: 'person@mail.ru',
  name: 'Человек',
  emailVerified: now,
  suspendedAt: null,
  isPlaceholder: false,
  webAuthnUserHandle: 'a'.repeat(43),
  passkeyCredentials: [{ id: 'old-credential' }],
};
const browserResponse = {
  id: 'new-credential',
  rawId: 'new-credential',
  type: 'public-key',
  response: {
    clientDataJSON: Buffer.from(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: challengeValue,
        origin: 'https://billok.ru',
      }),
    ).toString('base64url'),
    attestationObject: 'cbor',
  },
} as RegistrationResponseJSON;

function fixture() {
  const recovery = {
    id: 'recovery-1',
    userId: account.id,
    tokenHash: hashEmailVerificationToken(validToken),
    emailHash: hash(account.email),
    challengeHash: hash(challengeValue) as string | null,
    consumedAt: null as Date | null,
    expiresAt: new Date(now.getTime() + RECOVERY_TOKEN_TTL_MS),
    user: { ...account },
  };
  const webauthn = {
    id: 'challenge-1',
    userId: account.id,
    purpose: 'RECOVER',
    challengeHash: hash(challengeValue),
    bindingHash: hashWebAuthnBinding(secret),
    usedAt: null as Date | null,
    expiresAt: new Date(now.getTime() + 300_000),
  };
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue(account),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ownerBootstrap: { findUnique: vi.fn().mockResolvedValue(null) },
    passkeyRecoveryRequest: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockImplementation(async () => recovery),
      update: vi.fn().mockImplementation(async ({ data }) => {
        Object.assign(recovery, data);
        return recovery;
      }),
      create: vi.fn().mockResolvedValue({ id: 'new-recovery' }),
      updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
        if (where.id === recovery.id && recovery.consumedAt) return { count: 0 };
        if (where.id === recovery.id && data.consumedAt) recovery.consumedAt = data.consumedAt;
        return { count: 1 };
      }),
    },
    webAuthnChallenge: {
      findUnique: vi.fn().mockImplementation(async () => webauthn),
      create: vi.fn().mockResolvedValue(webauthn),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    passkeyCredential: {
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({ id: 'new-credential-row' }),
    },
    passkeyLoginTicket: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    session: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    adminAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: account.id }]),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };
  return { db, recovery, webauthn };
}
const client = (db: ReturnType<typeof fixture>['db']) => db as unknown as PrismaClient;

describe('Issue #1 6.8.1.3: email recovery must never become a login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateRegistrationOptions).mockResolvedValue({
      challenge: challengeValue,
      rp: { id: 'billok.ru', name: 'BillOK' },
      user: { id: 'abc', name: account.email, displayName: account.name },
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
          id: 'new-credential',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
      },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
  });

  it('never reveals missing accounts or sends email to unknown addresses', async () => {
    const { db } = fixture();
    db.user.findUnique.mockResolvedValue(null);
    expect(await requestPasskeyRecovery({ db: client(db), email: 'unknown@mail.ru', env, now })).toEqual({
      requested: true,
    });
    expect(sendRussianPasskeyRecoveryEmail).not.toHaveBeenCalled();
    expect(db.passkeyRecoveryRequest.create).not.toHaveBeenCalled();
  });

  it('refuses pending and blocked users as well as an owner whose bootstrap is incomplete', async () => {
    for (const patch of [{ emailVerified: null }, { suspendedAt: now }, { isPlaceholder: true }]) {
      const { db } = fixture();
      db.user.findUnique.mockResolvedValue({ ...account, ...patch });
      expect(await requestPasskeyRecovery({ db: client(db), email: account.email, env, now })).toEqual({
        requested: true,
      });
      expect(db.passkeyRecoveryRequest.create).not.toHaveBeenCalled();
    }
    const { db } = fixture();
    db.ownerBootstrap.findUnique.mockResolvedValue({ userId: account.id, completedAt: null });
    expect(await requestPasskeyRecovery({ db: client(db), email: account.email, env, now })).toEqual({
      requested: true,
    });
    expect(sendRussianPasskeyRecoveryEmail).not.toHaveBeenCalled();
  });

  it('allows a completed owner with any 1–3 keys to request one email replacement link', async () => {
    for (const count of [1, 2, 3]) {
      const { db } = fixture();
      db.ownerBootstrap.findUnique.mockResolvedValue({
        userId: account.id,
        completedAt: now,
      });
      db.user.findUnique.mockResolvedValue({
        ...account,
        passkeyCredentials: Array.from({ length: count }, (_, i) => ({ id: 'key-' + i })),
      });
      expect(
        await requestPasskeyRecovery({
          db: client(db),
          email: account.email,
          env,
          now,
        }),
      ).toEqual({ requested: true });
      expect(db.passkeyRecoveryRequest.create).toHaveBeenCalledTimes(1);
      expect(sendRussianPasskeyRecoveryEmail).toHaveBeenCalledTimes(1);
      expect(db.passkeyLoginTicket.deleteMany).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });

  it('never lets a missing owner key or a fourth active key use email recovery', async () => {
    for (const count of [0, 4]) {
      const { db } = fixture();
      db.ownerBootstrap.findUnique.mockResolvedValue({ userId: account.id, completedAt: now });
      db.user.findUnique.mockResolvedValue({
        ...account,
        passkeyCredentials: Array.from({ length: count }, (_, i) => ({ id: 'key-' + i })),
      });
      expect(
        await requestPasskeyRecovery({
          db: client(db),
          email: account.email,
          env,
          now,
        }),
      ).toEqual({ requested: true });
      expect(db.passkeyRecoveryRequest.create).not.toHaveBeenCalled();
      expect(sendRussianPasskeyRecoveryEmail).not.toHaveBeenCalled();
    }
  });

  it('refuses an incomplete bootstrap even if several legacy keys exist', async () => {
    const { db } = fixture();
    db.ownerBootstrap.findUnique.mockResolvedValue({ userId: account.id, completedAt: null });
    db.user.findUnique.mockResolvedValue({
      ...account,
      passkeyCredentials: [{ id: 'key-1' }, { id: 'key-2' }],
    });
    expect(
      await requestPasskeyRecovery({
        db: client(db),
        email: account.email,
        env,
        now,
      }),
    ).toEqual({ requested: true });
    expect(db.passkeyRecoveryRequest.create).not.toHaveBeenCalled();
  });

  it('stores only SHA-256 of recovery token, delivers to registered email and no session', async () => {
    const { db } = fixture();
    const result = await requestPasskeyRecovery({ db: client(db), email: 'PERSON@MAIL.RU', env, now });
    expect(result).toEqual({ requested: true });
    expect(db.passkeyRecoveryRequest.create).toHaveBeenCalledWith({
      data: {
        userId: account.id,
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        emailHash: hash(account.email),
        expiresAt: new Date(now.getTime() + RECOVERY_TOKEN_TTL_MS),
      },
      select: { id: true },
    });
    const email = vi.mocked(sendRussianPasskeyRecoveryEmail).mock.calls[0]![0];
    expect(email.to).toBe(account.email);
    expect(email.url).toMatch(/^https:\/\/billok\.ru\/recover-passkey\?token=/);
    const token = new URL(email.url).searchParams.get('token')!;
    expect(hashEmailVerificationToken(token)).toBe(db.passkeyRecoveryRequest.create.mock.calls[0]![0].data.tokenHash);
    expect(JSON.stringify(db.passkeyRecoveryRequest.create.mock.calls[0]![0])).not.toContain(token);
    expect(db.passkeyLoginTicket.deleteMany).not.toHaveBeenCalled();
  });

  it('does not allow an unregistered first Passkey to be created through recovery email', async () => {
    const { db } = fixture();
    db.user.findUnique.mockResolvedValue({ ...account, passkeyCredentials: [] });
    expect(await requestPasskeyRecovery({ db: client(db), email: account.email, env, now })).toEqual({
      requested: true,
    });
    expect(sendRussianPasskeyRecoveryEmail).not.toHaveBeenCalled();
    expect(db.passkeyRecoveryRequest.create).not.toHaveBeenCalled();
  });

  it('does not replace a key if the account has already lost its last active key in the database', async () => {
    const { db } = fixture();
    db.passkeyCredential.count.mockResolvedValue(0);
    await expect(
      finishPasskeyRecovery({
        db: client(db),
        token: validToken,
        bindingSecret: secret,
        response: browserResponse,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.create).not.toHaveBeenCalled();
  });

  it('server-side rate limit persists across requests; count never caps total lifetime recoveries', async () => {
    const { db } = fixture();
    db.passkeyRecoveryRequest.count.mockResolvedValue(RECOVERY_EMAIL_LIMIT_PER_HOUR);
    expect(await requestPasskeyRecovery({ db: client(db), email: account.email, env, now })).toEqual({
      requested: true,
    });
    expect(db.passkeyRecoveryRequest.create).not.toHaveBeenCalled();
    expect(db.passkeyRecoveryRequest.count).toHaveBeenCalledWith({
      where: { userId: account.id, createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
    });
  });

  it('invalidates unsent links on SMTP failure', async () => {
    const { db } = fixture();
    vi.mocked(sendRussianPasskeyRecoveryEmail).mockRejectedValueOnce(new Error('smtp down'));
    expect(await requestPasskeyRecovery({ db: client(db), email: account.email, env, now })).toEqual({
      requested: true,
    });
    expect(db.passkeyRecoveryRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'new-recovery', userId: account.id, consumedAt: null },
      data: { consumedAt: now },
    });
  });

  it('opens a five-minute WebAuthn registration challenge for a valid email token, not a session', async () => {
    const { db, recovery } = fixture();
    recovery.challengeHash = null;
    const result = await beginPasskeyRecovery({
      db: client(db),
      token: validToken,
      bindingSecret: secret,
      env,
      now,
    });
    expect(result.challenge).toBe(challengeValue);
    expect(db.webAuthnChallenge.create).toHaveBeenCalledWith({
      data: {
        purpose: 'RECOVER',
        userId: account.id,
        challengeHash: hash(challengeValue),
        bindingHash: hashWebAuthnBinding(secret),
        expiresAt: new Date(now.getTime() + 300_000),
      },
    });
    expect(db.passkeyRecoveryRequest.update).toHaveBeenCalledWith({
      where: { id: recovery.id },
      data: { challengeHash: hash(challengeValue) },
    });
    expect(vi.mocked(generateRegistrationOptions).mock.calls[0]![0]).toMatchObject({
      rpID: 'billok.ru',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    expect(db.passkeyLoginTicket.deleteMany).not.toHaveBeenCalled();
  });

  it('owner 1–3 active keys: email link opens only a signed WebAuthn enrollment, not a session', async () => {
    for (const count of [1, 2, 3]) {
      const { db, recovery } = fixture();
      recovery.user.passkeyCredentials = Array.from({ length: count }, (_, i) => ({ id: 'key-' + i }));
      db.ownerBootstrap.findUnique.mockResolvedValue({ userId: account.id, completedAt: now });
      await expect(
        beginPasskeyRecovery({
          db: client(db),
          token: validToken,
          bindingSecret: secret,
          env,
          now,
        }),
      ).resolves.toMatchObject({ challenge: challengeValue });
      expect(db.webAuthnChallenge.create).toHaveBeenCalledTimes(1);
      expect(db.passkeyLoginTicket).not.toHaveProperty('create');
    }
  });

  it('expired, suspended or incomplete owner cannot use an old recovery link', async () => {
    for (const owner of [
      { userId: account.id, completedAt: null },
      { userId: account.id, completedAt: now },
    ]) {
      const { db, recovery } = fixture();
      db.ownerBootstrap.findUnique.mockResolvedValue(owner);
      if (owner.completedAt) Object.assign(recovery.user, { suspendedAt: now });
      await expect(
        beginPasskeyRecovery({
          db: client(db),
          token: validToken,
          bindingSecret: secret,
          env,
          now,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
    }
  });

  it('does not accept an older email link after an email-address change', async () => {
    const { db, recovery } = fixture();
    recovery.user.email = 'updated@mail.ru';
    await expect(
      beginPasskeyRecovery({
        db: client(db),
        token: validToken,
        bindingSecret: secret,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
  });

  it('rejects malformed, used and expired links before issuing a challenge', async () => {
    const invalid = fixture();
    await expect(
      beginPasskeyRecovery({
        db: client(invalid.db),
        token: 'x',
        bindingSecret: secret,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(invalid.db.passkeyRecoveryRequest.findUnique).not.toHaveBeenCalled();
    for (const patch of [{ consumedAt: now }, { expiresAt: now }, { user: { ...account, suspendedAt: now } }]) {
      const { db, recovery } = fixture();
      Object.assign(recovery, patch);
      await expect(
        beginPasskeyRecovery({
          db: client(db),
          token: validToken,
          bindingSecret: secret,
          env,
          now,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.webAuthnChallenge.create).not.toHaveBeenCalled();
    }
  });

  it('rejects expired/used/wrong-browser challenges before verifying the response', async () => {
    for (const patch of [
      { usedAt: now },
      { expiresAt: now },
      { bindingHash: hashWebAuthnBinding('c'.repeat(43)) },
      { purpose: 'LOGIN' },
      { userId: 'someone-else' },
    ]) {
      const { db, webauthn } = fixture();
      Object.assign(webauthn, patch);
      await expect(
        finishPasskeyRecovery({
          db: client(db),
          token: validToken,
          bindingSecret: secret,
          response: browserResponse,
          env,
          now,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.passkeyCredential.create).not.toHaveBeenCalled();
      expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    }
  });

  it('rejects a signed WebAuthn attestation from the wrong origin or without UV', async () => {
    const { db } = fixture();
    vi.mocked(verifyRegistrationResponse).mockRejectedValueOnce(new Error('wrong origin'));
    await expect(
      finishPasskeyRecovery({
        db: client(db),
        token: validToken,
        bindingSecret: secret,
        response: browserResponse,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.$transaction).not.toHaveBeenCalled();
    const other = fixture();
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
      registrationInfo: { userVerified: false },
    } as Awaited<ReturnType<typeof verifyRegistrationResponse>>);
    await expect(
      finishPasskeyRecovery({
        db: client(other.db),
        token: validToken,
        bindingSecret: secret,
        response: browserResponse,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(other.db.$transaction).not.toHaveBeenCalled();
  });

  it('atomically creates new Passkey, revokes old key, rotates JWTs, tickets and all prior links', async () => {
    const { db, recovery } = fixture();
    const result = await finishPasskeyRecovery({
      db: client(db),
      token: validToken,
      bindingSecret: secret,
      response: browserResponse,
      env,
      now,
    });
    expect(result).toEqual({ recovered: true });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.passkeyRecoveryRequest.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: recovery.id, consumedAt: null, challengeHash: hash(challengeValue) }),
      data: { consumedAt: now },
    });
    expect(db.passkeyCredential.updateMany).toHaveBeenCalledWith({
      where: { userId: account.id, revokedAt: null },
      data: { revokedAt: now },
    });
    expect(db.passkeyCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: account.id,
        credentialId: 'new-credential',
        publicKey: Buffer.from([1, 2, 3]),
        backedUp: true,
      }),
    });
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { id: account.id },
      data: { sessionSecurityVersion: { increment: 1 } },
    });
    expect(db.webAuthnChallenge.deleteMany).toHaveBeenCalledWith({ where: { userId: account.id } });
    expect(db.passkeyLoginTicket.deleteMany).toHaveBeenCalledWith({ where: { userId: account.id } });
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: account.id } });
    expect(db.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        adminId: account.id,
        action: 'PASSKEY_RECOVERY_COMPLETED',
        metadata: {
          revokedPasskeys: 1,
          method: 'verified-email-plus-webauthn',
          accountType: 'regular',
        },
      },
    });
    expect(vi.mocked(verifyRegistrationResponse).mock.calls[0]![0]).toMatchObject({
      expectedOrigin: 'https://billok.ru',
      expectedRPID: 'billok.ru',
      requireUserPresence: true,
      requireUserVerification: true,
    });
    expect(db.passkeyLoginTicket).not.toHaveProperty('create');
  });

  it('atomically revokes ALL 1–3 owner keys, previous tickets and sessions, and audits the count', async () => {
    for (const count of [1, 2, 3]) {
      const { db, recovery } = fixture();
      recovery.user.passkeyCredentials = Array.from({ length: count }, (_, i) => ({ id: 'key-' + i }));
      db.ownerBootstrap.findUnique.mockResolvedValue({ userId: account.id, completedAt: now });
      db.passkeyCredential.count.mockResolvedValue(count);
      db.passkeyCredential.updateMany.mockResolvedValue({ count });
      expect(
        await finishPasskeyRecovery({
          db: client(db),
          token: validToken,
          bindingSecret: secret,
          response: browserResponse,
          env,
          now,
        }),
      ).toEqual({ recovered: true });
      expect(db.passkeyCredential.updateMany).toHaveBeenCalledWith({
        where: { userId: account.id, revokedAt: null },
        data: { revokedAt: now },
      });
      expect(db.passkeyCredential.create).toHaveBeenCalledTimes(1);
      expect(db.user.updateMany).toHaveBeenCalledWith({
        where: { id: account.id },
        data: { sessionSecurityVersion: { increment: 1 } },
      });
      expect(db.passkeyLoginTicket.deleteMany).toHaveBeenCalledWith({ where: { userId: account.id } });
      expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: account.id } });
      expect(db.adminAuditLog.create).toHaveBeenCalledWith({
        data: {
          adminId: account.id,
          action: 'PASSKEY_RECOVERY_COMPLETED',
          metadata: {
            revokedPasskeys: count,
            method: 'verified-email-plus-webauthn',
            accountType: 'owner',
          },
        },
      });
      expect(db.passkeyLoginTicket).not.toHaveProperty('create');
      vi.clearAllMocks();
    }
  });

  it('owner recovery rejects a fourth active key and leaves existing credentials intact', async () => {
    const { db, recovery } = fixture();
    recovery.user.passkeyCredentials = Array.from({ length: 4 }, (_, i) => ({ id: 'key-' + i }));
    db.ownerBootstrap.findUnique.mockResolvedValue({ userId: account.id, completedAt: now });
    db.passkeyCredential.count.mockResolvedValue(4);
    await expect(
      finishPasskeyRecovery({
        db: client(db),
        token: validToken,
        bindingSecret: secret,
        response: browserResponse,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.updateMany).not.toHaveBeenCalled();
    expect(db.passkeyCredential.create).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('owner recovery replay is blocked after the first one-time token is consumed', async () => {
    const { db, recovery } = fixture();
    recovery.user.passkeyCredentials = [{ id: 'old-1' }, { id: 'old-2' }];
    db.ownerBootstrap.findUnique.mockResolvedValue({ userId: account.id, completedAt: now });
    db.passkeyCredential.count.mockResolvedValue(2);
    db.passkeyCredential.updateMany.mockResolvedValue({ count: 2 });
    await finishPasskeyRecovery({
      db: client(db),
      token: validToken,
      bindingSecret: secret,
      response: browserResponse,
      env,
      now,
    });
    await expect(
      finishPasskeyRecovery({
        db: client(db),
        token: validToken,
        bindingSecret: secret,
        response: browserResponse,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.create).toHaveBeenCalledTimes(1);
  });

  it('refuses replay of the consumed email token after a successful replacement', async () => {
    const { db } = fixture();
    await finishPasskeyRecovery({
      db: client(db),
      token: validToken,
      bindingSecret: secret,
      response: browserResponse,
      env,
      now,
    });
    await expect(
      finishPasskeyRecovery({
        db: client(db),
        token: validToken,
        bindingSecret: secret,
        response: browserResponse,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.create).toHaveBeenCalledTimes(1);
  });

  it('losing concurrent token consumption cannot create the second new key', async () => {
    const { db } = fixture();
    db.passkeyRecoveryRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      finishPasskeyRecovery({
        db: client(db),
        token: validToken,
        bindingSecret: secret,
        response: browserResponse,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.updateMany).not.toHaveBeenCalled();
    expect(db.passkeyCredential.create).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('losing concurrent challenge consumption cannot create or revoke any passkey', async () => {
    const { db } = fixture();
    db.webAuthnChallenge.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      finishPasskeyRecovery({
        db: client(db),
        token: validToken,
        bindingSecret: secret,
        response: browserResponse,
        env,
        now,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.passkeyCredential.updateMany).not.toHaveBeenCalled();
    expect(db.passkeyCredential.create).not.toHaveBeenCalled();
  });
});
