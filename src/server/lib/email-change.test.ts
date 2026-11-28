import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  approveEmailChange,
  beginEmailChange,
  cancelEmailChange,
  completeEmailChange,
  emailChangeDigest,
  emailChangeStatus,
  EMAIL_CHANGE_TTL_MS,
} from './email-change';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  verify: vi.fn(),
  mail: vi.fn(),
  encrypt: vi.fn(),
  rotate: vi.fn(),
  limit: vi.fn(),
}));
vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mocks.generate,
  verifyAuthenticationResponse: mocks.verify,
}));
vi.mock('./email-change-notification', () => ({
  sendEmailChangeConfirmation: mocks.mail,
  encryptEmailChangeRecipient: mocks.encrypt,
  emailChangeNotificationExpiry: (now: Date) => new Date(now.getTime() + 7 * 86400_000),
}));
vi.mock('./revoke-account-auth', () => ({ revokeAccountAuthenticationStateInTransaction: mocks.rotate }));
vi.mock('./rate-limit', () => ({ checkTokenRateLimit: mocks.limit }));

const now = new Date('2026-11-28T09:00:00Z');
const oldEmail = 'old@mail.ru';
const newEmail = 'new@mail.su';
const challenge = 'C'.repeat(43);
const session = { userId: 'ordinary', version: 4, binding: 'b'.repeat(64) };
const assertion = { id: 'credential', response: {} } as AuthenticationResponseJSON;
const env = { NODE_ENV: 'production', AUTH_SECRET: 'a'.repeat(48) };

function fixture() {
  const user = {
    id: session.userId,
    email: oldEmail,
    emailVerified: now,
    isPlaceholder: false,
    suspendedAt: null as Date | null,
    sessionSecurityVersion: 4,
    passkeyCredentials: [{ id: 'key', credentialId: 'credential', transports: ['internal'] }],
  };
  const signer = {
    ...user.passkeyCredentials[0]!,
    userId: user.id,
    revokedAt: null as Date | null,
    signCount: BigInt(1),
    publicKey: Buffer.from([1, 2, 3]),
  };
  let saved: Record<string, unknown> | null = null;
  const db = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('').includes('lower(email)') ? [] : [{ id: user.id }],
    ),
    ownerBootstrap: { findUnique: vi.fn().mockResolvedValue({ userId: 'owner' }) },
    user: { findUnique: vi.fn().mockResolvedValue(user), update: vi.fn().mockResolvedValue(user) },
    emailChangeRequest: {
      findUnique: vi.fn(async () => saved),
      upsert: vi.fn(async ({ create }) => {
        saved = { ...create };
        return saved;
      }),
      update: vi.fn(async ({ data }) => {
        saved = { ...saved, ...data };
        return saved;
      }),
      delete: vi.fn(async () => {
        saved = null;
        return {};
      }),
      deleteMany: vi.fn(async () => {
        saved = null;
        return { count: 1 };
      }),
    },
    passkeyCredential: {
      findUnique: vi.fn().mockResolvedValue(signer),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    emailVerificationRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    emailChangeNotification: { create: vi.fn().mockResolvedValue({}) },
    securityEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
  };
  return {
    db,
    user,
    signer,
    get saved() {
      return saved;
    },
    set saved(value) {
      saved = value;
    },
    input: { db: db as unknown as PrismaClient, session, now, env },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.generate.mockResolvedValue({ challenge, rpId: 'billok.ru' });
  mocks.verify.mockResolvedValue({
    verified: true,
    authenticationInfo: {
      credentialID: 'credential',
      userVerified: true,
      newCounter: 2,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
    },
  });
  mocks.mail.mockResolvedValue(undefined);
  mocks.encrypt.mockReturnValue('encrypted-old-address');
  mocks.rotate.mockResolvedValue({ revoked: true });
  mocks.limit.mockReturnValue({ allowed: true });
});

async function pending(f: ReturnType<typeof fixture>) {
  await beginEmailChange({ ...f.input, email: newEmail });
  const result = await approveEmailChange({ ...f.input, response: assertion });
  const token = mocks.mail.mock.calls.at(-1)![1] as string;
  return { result, token };
}

describe('TASK-BILLOK-012 — dedicated email change', () => {
  it('creates a purpose-specific, session-bound challenge and sends mail only after verified Passkey', async () => {
    const f = fixture();
    const options = await beginEmailChange({ ...f.input, email: 'NEW@MAIL.SU' });
    expect(options.challenge).toBe(challenge);
    expect(f.saved).toMatchObject({
      userId: session.userId,
      oldEmailHash: emailChangeDigest(oldEmail),
      newEmail,
      sessionBindingHash: session.binding,
      sessionSecurityVersion: 4,
      challengeHash: emailChangeDigest(challenge),
      tokenHash: null,
      approvedAt: null,
    });
    expect(JSON.stringify(f.saved)).not.toContain(challenge);
    expect(mocks.mail).not.toHaveBeenCalled();
    expect(f.db.user.update).not.toHaveBeenCalled();
    const approval = await approveEmailChange({ ...f.input, response: assertion });
    const token = mocks.mail.mock.calls[0]![1] as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(approval).toEqual({
      email: newEmail,
      expiresAt: new Date(now.getTime() + EMAIL_CHANGE_TTL_MS).toISOString(),
      delivered: true,
    });
    expect(f.saved).toMatchObject({
      tokenHash: emailChangeDigest(token),
      signerCredentialRowId: 'key',
      approvedAt: now,
    });
    expect(JSON.stringify(f.saved)).not.toContain(token);
    expect(mocks.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: 'https://billok.ru',
        expectedRPID: 'billok.ru',
        requireUserVerification: true,
      }),
    );
    const verifyArgs = mocks.verify.mock.calls[0]![0];
    expect(verifyArgs.expectedChallenge(challenge)).toBe(true);
    expect(verifyArgs.expectedChallenge('other')).toBe(false);
    expect(f.db.user.update).not.toHaveBeenCalled();
    expect(await emailChangeStatus(f.input)).toEqual({
      allowed: true,
      owner: false,
      pending: { email: newEmail, expiresAt: approval.expiresAt },
    });
  });

  it.each(['owner', 'no-owner', 'unverified', 'suspended', 'placeholder', 'no-key', 'stale-version'])(
    'rejects %s at every state-changing phase',
    async (reason) => {
      const f = fixture();
      if (reason === 'owner')
        f.db.ownerBootstrap.findUnique.mockResolvedValue({ userId: session.userId, completedAt: null });
      if (reason === 'no-owner') f.db.ownerBootstrap.findUnique.mockResolvedValue(null);
      if (reason === 'unverified') f.db.user.findUnique.mockResolvedValue({ ...f.user, emailVerified: null });
      if (reason === 'suspended') f.user.suspendedAt = now;
      if (reason === 'placeholder') f.user.isPlaceholder = true;
      if (reason === 'no-key') f.user.passkeyCredentials = [];
      if (reason === 'stale-version') f.user.sessionSecurityVersion = 5;
      for (const action of [
        () => beginEmailChange({ ...f.input, email: newEmail }),
        () => approveEmailChange({ ...f.input, response: assertion }),
        () => cancelEmailChange(f.input),
        () => completeEmailChange({ ...f.input, token: 'X'.repeat(43) }),
      ])
        await expect(action()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.emailChangeRequest.upsert).not.toHaveBeenCalled();
      expect(f.db.user.update).not.toHaveBeenCalled();
      expect(mocks.mail).not.toHaveBeenCalled();
      if (reason === 'owner')
        expect(await emailChangeStatus(f.input)).toEqual({ allowed: false, owner: true, pending: null });
    },
  );

  it('fails closed if the owner lookup fails', async () => {
    const f = fixture();
    f.db.ownerBootstrap.findUnique.mockRejectedValue(new Error('database unavailable'));
    await expect(beginEmailChange({ ...f.input, email: newEmail })).rejects.toThrow();
    expect(f.db.emailChangeRequest.upsert).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'foreign@example.com', 'old@MAIL.RU', 'new@mail.ru.evil.com'])(
    'rejects invalid or unchanged %s',
    async (email) => {
      const f = fixture();
      await expect(beginEmailChange({ ...f.input, email })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(f.db.emailChangeRequest.upsert).not.toHaveBeenCalled();
    },
  );

  it('does not disclose occupied address and verifies availability again before commit', async () => {
    const f = fixture();
    const { token } = await pending(f);
    f.db.$queryRaw.mockImplementation(async (strings) =>
      strings.join('').includes('lower(email)') ? [{ id: 'another' }] : [{ id: f.user.id }],
    );
    await expect(completeEmailChange({ ...f.input, token })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.db.user.update).not.toHaveBeenCalled();
    expect(f.db.emailChangeRequest.delete).not.toHaveBeenCalled();
    const second = fixture();
    second.db.$queryRaw.mockImplementation(f.db.$queryRaw.getMockImplementation()!);
    await expect(beginEmailChange({ ...second.input, email: newEmail })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each([
    'wrong-session',
    'expired',
    'revoked',
    'foreign-key',
    'invalid-signature',
    'not-verified',
    'stale-counter',
    'already-approved',
    'delivery-rate',
  ])('rejects approval: %s', async (reason) => {
    const f = fixture();
    await beginEmailChange({ ...f.input, email: newEmail });
    let input = f.input;
    if (reason === 'wrong-session') input = { ...input, session: { ...session, binding: 'c'.repeat(64) } };
    if (reason === 'expired') input = { ...input, now: new Date(now.getTime() + 6 * 60_000) };
    if (reason === 'revoked') f.signer.revokedAt = now;
    if (reason === 'foreign-key') f.signer.userId = 'other';
    if (reason === 'invalid-signature') mocks.verify.mockRejectedValue(new Error('invalid'));
    if (reason === 'not-verified')
      mocks.verify.mockResolvedValue({
        verified: true,
        authenticationInfo: { credentialID: 'credential', userVerified: false, newCounter: 2 },
      });
    if (reason === 'stale-counter')
      mocks.verify.mockResolvedValue({
        verified: true,
        authenticationInfo: { credentialID: 'credential', userVerified: true, newCounter: 1 },
      });
    if (reason === 'already-approved') f.saved = { ...f.saved, approvedAt: now };
    if (reason === 'delivery-rate') mocks.limit.mockReturnValue({ allowed: false });
    await expect(approveEmailChange({ ...input, response: assertion })).rejects.toMatchObject({
      code: reason === 'delivery-rate' ? 'TOO_MANY_REQUESTS' : 'FORBIDDEN',
    });
    expect(mocks.mail).not.toHaveBeenCalled();
    expect(f.db.user.update).not.toHaveBeenCalled();
  });

  it('consumes exactly one pending token, preserves identity, invalidates old authentication, queues encrypted notice and audits transactionally', async () => {
    const f = fixture();
    const { token } = await pending(f);
    const requestId = f.saved!.id;
    expect(await completeEmailChange({ ...f.input, token })).toEqual({ changed: true });
    expect(f.db.user.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: session.userId },
      data: { email: newEmail, emailVerified: now },
    });
    expect(mocks.rotate).toHaveBeenCalledWith(f.db, session.userId);
    expect(f.db.emailVerificationRequest.updateMany).toHaveBeenCalledWith({
      where: { userId: session.userId, consumedAt: null },
      data: { consumedAt: now },
    });
    expect(f.db.emailChangeNotification.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        id: requestId,
        userId: session.userId,
        encryptedRecipient: 'encrypted-old-address',
        expiresAt: new Date(now.getTime() + 7 * 86400_000),
      },
    });
    expect(f.db.securityEvent.create).toHaveBeenCalledWith({
      data: { actorId: session.userId, action: 'EMAIL_CHANGE_COMPLETED', outcome: 'ALLOWED' },
    });
    expect(f.saved).toBeNull();
    await expect(completeEmailChange({ ...f.input, token })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.user.update).toHaveBeenCalledTimes(1);
  });

  it.each(['wrong-token', 'wrong-session', 'expired', 'old-email-changed', 'signer-removed', 'unapproved'])(
    'rejects completion: %s',
    async (reason) => {
      const f = fixture();
      const { token } = await pending(f);
      const input = { ...f.input, token };
      if (reason === 'wrong-token') input.token = 'X'.repeat(43);
      if (reason === 'wrong-session') input.session = { ...session, binding: 'c'.repeat(64) };
      if (reason === 'expired') input.now = new Date(now.getTime() + EMAIL_CHANGE_TTL_MS);
      if (reason === 'old-email-changed') f.user.email = 'different@mail.ru';
      if (reason === 'signer-removed')
        f.user.passkeyCredentials = [{ id: 'different', credentialId: 'different', transports: [] }];
      if (reason === 'unapproved') f.saved = { ...f.saved, approvedAt: null };
      await expect(completeEmailChange(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.user.update).not.toHaveBeenCalled();
      expect(f.db.emailChangeNotification.create).not.toHaveBeenCalled();
    },
  );

  it('SMTP failure leaves old identity unchanged; fresh approval replaces token; cancellation invalidates it', async () => {
    const f = fixture();
    mocks.mail.mockRejectedValueOnce(new Error('SMTP failed'));
    const first = await pending(f);
    expect(first.result.delivered).toBe(false);
    expect(f.db.user.update).not.toHaveBeenCalled();
    const next = await pending(f);
    expect(next.token).not.toBe(first.token);
    await expect(completeEmailChange({ ...f.input, token: first.token })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await cancelEmailChange(f.input);
    expect(f.saved).toBeNull();
    await expect(completeEmailChange({ ...f.input, token: next.token })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.user.update).not.toHaveBeenCalled();
    expect(f.db.securityEvent.create).toHaveBeenCalledWith({
      data: { actorId: session.userId, action: 'EMAIL_CHANGE_CANCELLED', outcome: 'ALLOWED' },
    });
  });
});
