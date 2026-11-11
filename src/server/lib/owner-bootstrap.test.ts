import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import {
  canRetryOwnerInitialPasskey,
  createInitialOwner,
  readOwnerBootstrapConfiguration,
  sendOwnerBootstrapConfirmation,
} from './owner-bootstrap';
import { issueRegistrationVerification } from './registration-verification-issue';

vi.mock('./registration-verification-issue', () => ({ issueRegistrationVerification: vi.fn() }));
const now = new Date('2026-11-11T12:00:00.000Z');
const env = {
  BILLOK_OWNER_BOOTSTRAP_ACK: 'CREATE_INITIAL_OWNER',
  ADMIN_EMAIL: 'owner@example.ru',
  EMAIL_SERVER_HOST: 'smtp.example.ru',
  EMAIL_SERVER_PORT: '465',
  EMAIL_SERVER_USER: 'noreply@billok.ru',
  EMAIL_SERVER_PASSWORD: 'test-only',
  NEXTAUTH_URL: 'https://billok.ru',
  NODE_ENV: 'production',
};

function database() {
  const user = {
    id: 'owner-1',
    email: env.ADMIN_EMAIL,
    emailVerified: null as Date | null,
    passkeyCredentials: [] as { id: string }[],
    suspendedAt: null as Date | null,
  };
  let bootstrap: {
    id: number;
    userId: string;
    emailAttempts: number;
    lastEmailAttemptAt: Date | null;
    completedAt: Date | null;
    user: typeof user;
  } | null = null;
  let numUsers = 0;
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    ownerBootstrap: {
      findUnique: vi.fn().mockImplementation(async () => bootstrap),
      create: vi.fn().mockImplementation(async () => {
        bootstrap = {
          id: 1,
          userId: user.id,
          emailAttempts: 0,
          lastEmailAttemptAt: null,
          completedAt: null,
          user,
        };
        return bootstrap;
      }),
      update: vi.fn().mockImplementation(async ({ data }) => {
        if (bootstrap) {
          bootstrap.emailAttempts += data.emailAttempts.increment;
          bootstrap.lastEmailAttemptAt = data.lastEmailAttemptAt;
        }
      }),
    },
    user: {
      count: vi.fn().mockImplementation(async () => numUsers),
      findUnique: vi.fn().mockImplementation(async () => user),
      create: vi.fn().mockImplementation(async () => {
        numUsers++;
        return user;
      }),
    },
    systemInvite: {
      create: vi.fn().mockResolvedValue({ id: 'owner-invite' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'owner-invite' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    adminAuditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    emailVerificationRequest: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  };
  return { db: db as unknown as PrismaClient, tx, user, getBootstrap: () => bootstrap };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(issueRegistrationVerification).mockResolvedValue({ expiresAt: now });
});

describe('Issue #1 6.3.2.2.2: local-only first owner without a password', () => {
  it.each([
    { ADMIN_EMAIL: 'owner@gmail.com' },
    { ADMIN_EMAIL: 'owner@example.ru.evil.com' },
    { ADMIN_EMAIL: 'OWNER@example.ru' },
    { ADMIN_EMAIL: '' },
    { BILLOK_OWNER_BOOTSTRAP_ACK: undefined },
    { NEXTAUTH_URL: 'http://billok.ru' },
    { NEXTAUTH_URL: 'https://evil.ru' },
  ])('refuses unsafe operator configuration %s', (patch) => {
    expect(() => readOwnerBootstrapConfiguration({ ...env, ...patch })).toThrow();
  });

  it('creates the only owner atomically, unverified and without password, with private 7-day invite and audit', async () => {
    const { db, tx } = database();
    const result = await createInitialOwner({ db, env, now });
    expect(result).toEqual({ userId: 'owner-1', email: 'owner@example.ru' });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.user.count).toHaveBeenCalled();
    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: env.ADMIN_EMAIL,
        passwordHash: null,
        emailVerified: null,
        registrationEmailVerificationRequired: true,
        locale: 'ru',
      }),
      select: { id: true, email: true },
    });
    const invite = tx.systemInvite.create.mock.calls[0]![0].data;
    expect(invite.label).toContain('владельца');
    expect(invite.code).toMatch(/^owner-[a-f0-9]{40}$/);
    expect(invite).toMatchObject({
      reservedById: 'owner-1',
      reservedUntil: new Date('2026-11-11T12:30:00.000Z'),
      expiresAt: new Date('2026-11-18T12:00:00.000Z'),
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'OWNER_BOOTSTRAP_STARTED', adminId: 'owner-1' }),
    });
    expect(JSON.stringify(tx.adminAuditLog.create.mock.calls)).not.toContain(invite.code);
    await expect(createInitialOwner({ db, env, now })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(tx.user.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a nonempty server before any write', async () => {
    const { db, tx } = database();
    tx.user.count.mockResolvedValueOnce(1);
    await expect(createInitialOwner({ db, env, now })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('sends an owner-specific verified email link without granting a session or exposing tokens in audit', async () => {
    const { db, tx } = database();
    await createInitialOwner({ db, env, now });
    await expect(sendOwnerBootstrapConfirmation({ db, env, now })).resolves.toEqual({ sent: true });
    expect(issueRegistrationVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationPath: '/setup-owner',
        userId: 'owner-1',
        email: env.ADMIN_EMAIL,
        siteOrigin: 'https://billok.ru',
      }),
    );
    expect(tx.emailVerificationRequest.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'owner-1', consumedAt: null },
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        adminId: 'owner-1',
        action: 'OWNER_BOOTSTRAP_EMAIL_SENT',
      }),
    });
    await expect(sendOwnerBootstrapConfirmation({ db, env, now })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const next = new Date(now.getTime() + 61_000);
    await expect(sendOwnerBootstrapConfirmation({ db, env, now: next })).resolves.toEqual({ sent: true });
  });

  it('never treats the email token as login, only as first-key setup and only during original TTL', async () => {
    const { db, tx, user } = database();
    await createInitialOwner({ db, env, now });
    user.emailVerified = now;
    tx.emailVerificationRequest.findUnique.mockResolvedValue({
      userId: user.id,
      consumedAt: now,
      expiresAt: new Date(now.getTime() + 90_000),
    });
    expect(await canRetryOwnerInitialPasskey(db, user.id, 'tokenhash', now)).toBe(true);
    expect(await canRetryOwnerInitialPasskey(db, 'another-user', 'tokenhash', now)).toBe(false);
    expect(await canRetryOwnerInitialPasskey(db, user.id, 'tokenhash', new Date(now.getTime() + 90_000))).toBe(false);
    user.passkeyCredentials.push({ id: 'first-key' });
    expect(await canRetryOwnerInitialPasskey(db, user.id, 'tokenhash', now)).toBe(false);
  });

  it('does not log email confirmation as delivered if SMTP fails', async () => {
    const { db, tx } = database();
    await createInitialOwner({ db, env, now });
    vi.mocked(issueRegistrationVerification).mockRejectedValueOnce(new Error('SMTP failed'));
    await expect(sendOwnerBootstrapConfirmation({ db, env, now })).rejects.toThrow('SMTP failed');
    expect(
      tx.adminAuditLog.create.mock.calls.filter((call) => call[0]?.data?.action === 'OWNER_BOOTSTRAP_EMAIL_SENT'),
    ).toHaveLength(0);
  });
});
