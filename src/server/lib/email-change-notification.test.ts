import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import {
  decryptEmailChangeRecipient,
  encryptEmailChangeRecipient,
  emailChangeNotificationExpiry,
  processEmailChangeNotifications,
  sendEmailChangeConfirmation,
} from './email-change-notification';

const { send, config } = vi.hoisted(() => ({ send: vi.fn(), config: vi.fn() }));
vi.mock('./transactional-email', () => ({ sendBillokTransactionalEmail: send }));
vi.mock('./auth-config', () => ({ readRegistrationEmailConfig: config }));
const env = { AUTH_SECRET: 'a'.repeat(48), NODE_ENV: 'production' };
const email = 'old@mail.ru';
beforeEach(() => {
  vi.resetAllMocks();
  send.mockResolvedValue(undefined);
  config.mockReturnValue({ siteOrigin: 'https://billok.ru', from: 'noreply@billok.ru', server: {} });
});
describe('TASK-BILLOK-012 — encrypted notice outbox', () => {
  it('authenticated encryption is random, operation-bound and rejects tampering or wrong key', () => {
    const ciphertext = encryptEmailChangeRecipient(email, 'op', env);
    expect(ciphertext).not.toContain(email);
    expect(encryptEmailChangeRecipient(email, 'op', env)).not.toBe(ciphertext);
    expect(decryptEmailChangeRecipient(ciphertext, 'op', env)).toBe(email);
    expect(() => decryptEmailChangeRecipient(ciphertext, 'another', env)).toThrow();
    expect(() => decryptEmailChangeRecipient(ciphertext, 'op', { AUTH_SECRET: 'b'.repeat(48) })).toThrow();
    expect(() => decryptEmailChangeRecipient('bad', 'op', env)).toThrow();
    expect(() => encryptEmailChangeRecipient(email, 'op', {})).toThrow();
  });
  it('email confirmation puts a token only in a fragment, refuses other origins', async () => {
    await sendEmailChangeConfirmation('new@mail.su', 'T'.repeat(43), env);
    const message = send.mock.calls[0]![0];
    expect(message.to).toBe('new@mail.su');
    expect(message.message.text).toContain('https://billok.ru/settings#email-change=' + 'T'.repeat(43));
    expect(message.message.text).not.toContain('?token=');
    config.mockReturnValue({ siteOrigin: 'https://evil.invalid', from: 'noreply@billok.ru', server: {} });
    await expect(sendEmailChangeConfirmation('new@mail.su', 'T'.repeat(43), env)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  function fixture() {
    const now = new Date();
    const entry = {
      id: 'op',
      userId: 'user',
      encryptedRecipient: encryptEmailChangeRecipient(email, 'op', env),
      attempts: 0,
      expiresAt: emailChangeNotificationExpiry(now),
      nextAttemptAt: now,
      leaseUntil: null,
      leaseId: null,
    };
    const db = {
      emailChangeRequest: {
        findMany: vi.fn().mockResolvedValue([{ id: 'expired-request' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      emailChangeNotification: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'expired-notice' }])
          .mockResolvedValue([entry]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { now, entry, db, asDb: db as unknown as PrismaClient };
  }
  it('claims a bounded lease, sends old address notice with no credential and deletes only own lease', async () => {
    const f = fixture();
    await processEmailChangeNotifications(f.asDb, env, f.now);
    expect(f.db.emailChangeRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    expect(f.db.emailChangeRequest.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['expired-request'] }, expiresAt: { lte: f.now } },
    });
    const claim = f.db.emailChangeNotification.updateMany.mock.calls[0]![0];
    expect(claim.data.attempts).toEqual({ increment: 1 });
    expect(claim.data.leaseId).toBeTruthy();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: email,
        message: expect.objectContaining({ subject: 'BillOK — изменена электронная почта' }),
      }),
    );
    expect(send.mock.calls[0]![0].message.text).not.toMatch(/https?:\/\//u);
    expect(f.db.emailChangeNotification.deleteMany).toHaveBeenLastCalledWith({
      where: { id: 'op', leaseId: claim.data.leaseId },
    });
  });
  it('does not deliver if another worker owns the lease; retries failure without repeating account update', async () => {
    const f = fixture();
    f.db.emailChangeNotification.updateMany.mockResolvedValueOnce({ count: 0 });
    await processEmailChangeNotifications(f.asDb, env, f.now);
    expect(send).not.toHaveBeenCalled();
    const g = fixture();
    send.mockRejectedValueOnce(new Error('SMTP failed'));
    await processEmailChangeNotifications(g.asDb, env, g.now);
    expect(g.db.emailChangeNotification.updateMany).toHaveBeenCalledTimes(2);
    const first = g.db.emailChangeNotification.updateMany.mock.calls[0]![0];
    const retry = g.db.emailChangeNotification.updateMany.mock.calls[1]![0];
    expect(retry).toMatchObject({
      where: { id: 'op', leaseId: first.data.leaseId },
      data: { leaseId: null, leaseUntil: null, nextAttemptAt: expect.any(Date) },
    });
    expect(retry.data.nextAttemptAt.getTime()).toBeGreaterThan(g.now.getTime());
    expect(g.db.emailChangeNotification.deleteMany).toHaveBeenCalledTimes(1);
  });
});
