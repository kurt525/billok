import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';

const { prepare, send, logError } = vi.hoisted(() => ({
  prepare: vi.fn(),
  send: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('./registration-resend-preparation', () => ({ preparePendingVerificationResend: prepare }));
vi.mock('./email-verification-email', () => ({ sendRussianRegistrationVerificationEmail: send }));
vi.mock('./logger', () => ({ logger: { error: logError } }));

import { deliverPendingVerificationResend } from './registration-resend-delivery';

const deleteMany = vi.fn();
const db = { $transaction: vi.fn(), emailVerificationRequest: { deleteMany } } as unknown as Pick<
  PrismaClient,
  '$transaction' | 'emailVerificationRequest'
>;
const now = new Date('2026-11-01T15:30:00.000Z');
const url = 'https://billok.ru/verify-email?token=' + 'Z'.repeat(43);
const input = {
  db,
  userId: 'pending-1',
  inviteCode: 'my-invite',
  email: 'person@mail.ru',
  siteOrigin: 'https://billok.ru',
  from: 'BillOK <noreply@billok.ru>',
  server: { host: 'smtp.example.test', port: 587, secure: false, requireTLS: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  prepare.mockResolvedValue({ requestId: 'replacement-1', url, expiresAt: now });
  send.mockResolvedValue(undefined);
  deleteMany.mockResolvedValue({ count: 1 });
});

describe('resend delivery without invalidating previous confirmation links', () => {
  it('delivers only after preparation and returns no raw confirmation token', async () => {
    const response = await deliverPendingVerificationResend(input);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(db, {
      userId: 'pending-1',
      inviteCode: 'my-invite',
      siteOrigin: 'https://billok.ru',
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      to: input.email,
      url,
      from: input.from,
      server: input.server,
    });
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(response).toEqual({ requestId: 'replacement-1', expiresAt: now });
    expect(JSON.stringify(response)).not.toContain('token=');
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('does not send if the account has lost its invitation reservation', async () => {
    prepare.mockResolvedValueOnce(null);
    await expect(deliverPendingVerificationResend(input)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('on SMTP failure removes only the new unused token and never releases the invitation', async () => {
    send.mockRejectedValueOnce(new Error('SMTP refused'));
    await expect(deliverPendingVerificationResend(input)).rejects.toThrow('SMTP refused');
    expect(deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'replacement-1', userId: 'pending-1', consumedAt: null },
    });
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[0]!);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('keeps the original SMTP error when token cleanup also fails', async () => {
    send.mockRejectedValueOnce(new Error('Original SMTP error'));
    deleteMany.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(deliverPendingVerificationResend(input)).rejects.toThrow('Original SMTP error');
    expect(logError).toHaveBeenCalledExactlyOnceWith('auth.registration_resend_token_cleanup_failed', {
      requestId: 'replacement-1',
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain(url);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(input.email);
  });
});
