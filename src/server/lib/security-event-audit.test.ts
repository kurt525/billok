import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import {
  recordOwnerSecurityEvent,
  russianSecurityAlert,
  securityTargetFingerprint,
  securityTargetFromInput,
} from './security-event-audit';

const { sendMail, createTransport } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

const env = {
  NODE_ENV: 'production',
  NEXTAUTH_URL: 'https://billok.ru',
  EMAIL_SERVER_HOST: 'smtp.example.ru',
  EMAIL_SERVER_PORT: '465',
  EMAIL_SERVER_USER: 'noreply@billok.ru',
  EMAIL_SERVER_PASSWORD: 'not-real',
};
const at = new Date('2026-11-15T11:30:00Z');
function database() {
  const db = {
    securityEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
    securityAlertDelivery: { create: vi.fn().mockResolvedValue({ bucket: 'claimed' }) },
    ownerBootstrap: {
      findUnique: vi.fn().mockResolvedValue({
        id: 1,
        completedAt: at,
        user: { email: 'real-owner@mail.ru', emailVerified: at, suspendedAt: null, isPlaceholder: false },
      }),
    },
  };
  return db;
}
const asDb = (db: ReturnType<typeof database>) => db as unknown as PrismaClient;

beforeEach(() => {
  vi.clearAllMocks();
  createTransport.mockReturnValue({ sendMail });
  sendMail.mockResolvedValue({ accepted: ['real-owner@mail.ru'], rejected: [], pending: [] });
});

describe('6.12.9: immutable-role security event details and owner alert delivery', () => {
  it('never exposes arbitrary request JSON, emails, raw token, cookie, or target ID', () => {
    const token = 't'.repeat(43);
    const ref = securityTargetFromInput({
      userId: token,
      approvalToken: 'secret',
      email: 'attacker@gmail.com',
      role: 'OWNER',
    });
    expect(ref).toMatch(/^[a-f0-9]{64}$/u);
    expect(ref).toBe(securityTargetFingerprint(token));
    expect(ref).not.toContain(token);
    expect(securityTargetFromInput({ approvalToken: token })).toBeNull();
    expect(securityTargetFromInput({ userId: '', targetId: 'real-target' })).toBeNull();
    expect(securityTargetFromInput({ targetId: { email: 'secret@mail.ru' } })).toBeNull();
    expect(securityTargetFromInput(null)).toBeNull();
  });

  it('records every denied attempt but sends only one alert per 15-minute bucket', async () => {
    const db = database();
    let claimed = false;
    db.securityAlertDelivery.create.mockImplementation(async () => {
      if (claimed) throw new Error('duplicate bucket');
      claimed = true;
      return { bucket: 'claimed' };
    });
    const fp = securityTargetFingerprint('target-user');
    for (let i = 0; i < 8; i++) {
      await recordOwnerSecurityEvent({
        db: asDb(db),
        action: 'admin.deleteUser',
        outcome: 'DENIED',
        actorId: 'ordinary-user',
        targetFingerprint: fp,
        env,
        now: at,
      });
    }
    expect(db.securityEvent.create).toHaveBeenCalledTimes(8);
    expect(db.securityAlertDelivery.create).toHaveBeenCalledTimes(8);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const saved = db.securityEvent.create.mock.calls[0]![0].data;
    expect(saved).toMatchObject({
      action: 'admin.deleteUser',
      outcome: 'DENIED',
      actorId: 'ordinary-user',
      targetFingerprint: fp,
      createdAt: at,
    });
    expect(JSON.stringify(saved)).not.toContain('approvalToken');
    expect(JSON.stringify(saved)).not.toContain('target-user');
    const notice = sendMail.mock.calls[0]![0];
    expect(notice.to).toBe('real-owner@mail.ru');
    expect(notice.from).toBe('BillOK <noreply@billok.ru>');
    expect(notice.text).toContain('Отклонено');
    expect(JSON.stringify(notice)).not.toContain('target-user');
  });

  it('critical approved operations notify without throttling owner actions; ordinary queries do not', async () => {
    const db = database();
    for (let i = 0; i < 12; i++) {
      await recordOwnerSecurityEvent({
        db: asDb(db),
        action: 'OWNER_PASSKEY_REVOKED',
        outcome: 'ALLOWED',
        actorId: 'real-owner',
        env,
        now: at,
      });
    }
    expect(db.securityEvent.create).toHaveBeenCalledTimes(12);
    expect(sendMail).toHaveBeenCalledTimes(12);
    expect(db.securityAlertDelivery.create).not.toHaveBeenCalled();
    await recordOwnerSecurityEvent({
      db: asDb(db),
      action: 'admin.getSecurityEvents',
      outcome: 'ALLOWED',
      env,
      now: at,
    });
    expect(sendMail).toHaveBeenCalledTimes(12);
  });

  it('only the verified current DB owner is notified; client ADMIN_EMAIL cannot redirect', async () => {
    const db = database();
    for (const owner of [
      null,
      { completedAt: null, user: { email: 'owner@mail.ru', emailVerified: at } },
      { completedAt: at, user: { email: 'owner@mail.ru', emailVerified: null } },
      { completedAt: at, user: { email: 'owner@mail.ru', emailVerified: at, suspendedAt: at } },
      { completedAt: at, user: { email: 'owner@mail.ru', emailVerified: at, isPlaceholder: true } },
    ]) {
      db.ownerBootstrap.findUnique.mockResolvedValueOnce(owner);
      await recordOwnerSecurityEvent({
        db: asDb(db),
        action: 'ADMIN_EXPORT',
        outcome: 'ALLOWED',
        env: { ...env, ADMIN_EMAIL: 'attacker@mail.ru' },
        now: at,
      });
    }
    expect(sendMail).not.toHaveBeenCalled();
    await recordOwnerSecurityEvent({
      db: asDb(db),
      action: 'ADMIN_EXPORT',
      outcome: 'ALLOWED',
      env: { ...env, ADMIN_EMAIL: 'attacker@mail.ru' },
      now: at,
    });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'real-owner@mail.ru' }));
  });

  it('notification failures never grant denied operations or undo a committed security event', async () => {
    const db = database();
    sendMail.mockRejectedValueOnce(new Error('SMTP unavailable'));
    await expect(
      recordOwnerSecurityEvent({
        db: asDb(db),
        action: 'IMPERSONATION_STARTED',
        outcome: 'ALLOWED',
        actorId: 'real-owner',
        env,
        now: at,
      }),
    ).resolves.toBeUndefined();
    expect(db.securityEvent.create).toHaveBeenCalledOnce();
    db.securityEvent.create.mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(
      recordOwnerSecurityEvent({
        db: asDb(db),
        action: 'OWNER_BOOTSTRAP_REPLAY',
        outcome: 'DENIED',
        env,
        now: at,
      }),
    ).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('notification template never carries links, tokens or authentication capabilities', () => {
    const text = JSON.stringify(
      russianSecurityAlert({
        action: 'OWNER_PASSKEY_ADDED',
        outcome: 'ALLOWED',
        actorId: 'owner-1',
        targetFingerprint: securityTargetFingerprint('key-1'),
        when: at,
      }),
    );
    for (const forbidden of ['https://', 'recover-passkey', 'approvalToken', 'authjs', 'session-token', 'key-1']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain('Выполнено');
  });

  it('ignores arbitrary action names and never stores the body of unrecognized events', async () => {
    const db = database();
    await recordOwnerSecurityEvent({
      db: asDb(db),
      action: 'evil\nsecret=abc',
      outcome: 'DENIED',
      actorId: 'owner-1',
      env,
    });
    expect(db.securityEvent.create).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
