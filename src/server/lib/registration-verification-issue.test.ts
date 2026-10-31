import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock('./email-verification-email', () => ({
  sendRussianRegistrationVerificationEmail: sendEmail,
}));

import { issueRegistrationVerification } from './registration-verification-issue';

const create = vi.fn();
const deleteMany = vi.fn();
const db = { emailVerificationRequest: { create, deleteMany } } as unknown as Pick<
  PrismaClient,
  'emailVerificationRequest'
>;
const input = {
  db,
  userId: 'unverified-account-1',
  email: 'member@example.ru',
  siteOrigin: 'https://billok.ru',
  from: 'BillOK <noreply@billok.ru>',
  server: { host: 'smtp.example.test', port: 587, secure: false, requireTLS: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: 'verification-request-1' });
  deleteMany.mockResolvedValue({ count: 1 });
  sendEmail.mockResolvedValue(undefined);
});

describe('persist-and-send registration confirmation', () => {
  it('persists the hash, sends the matching raw link, and never consumes an invitation', async () => {
    const result = await issueRegistrationVerification(input);

    expect(create).toHaveBeenCalledOnce();
    const record = create.mock.calls[0][0];
    expect(record).toEqual({
      data: {
        userId: input.userId,
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: expect.any(Date),
      },
      select: { id: true },
    });
    expect(sendEmail).toHaveBeenCalledOnce();
    const sent = sendEmail.mock.calls[0][0];
    expect(sent.to).toBe(input.email);
    expect(sent.from).toBe(input.from);
    expect(sent.server).toBe(input.server);
    expect(sent.url).toMatch(/^https:\/\/billok\.ru\/verify-email\?token=/);
    expect(record.data.tokenHash).not.toBe(new URL(sent.url).searchParams.get('token'));
    expect(Object.keys(record.data).sort()).toEqual(['expiresAt', 'tokenHash', 'userId']);
    expect(result.expiresAt).toEqual(record.data.expiresAt);
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(sendEmail.mock.invocationCallOrder[0]);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('does not send an email if the database fails to persist the request', async () => {
    create.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(issueRegistrationVerification(input)).rejects.toThrow('Database unavailable');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('discards the new unconsumed request if SMTP rejects delivery', async () => {
    sendEmail.mockRejectedValueOnce(new Error('SMTP rejected'));
    await expect(issueRegistrationVerification(input)).rejects.toThrow('SMTP rejected');
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: 'verification-request-1', userId: input.userId, consumedAt: null },
    });
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(sendEmail.mock.invocationCallOrder[0]);
    expect(sendEmail.mock.invocationCallOrder[0]).toBeLessThan(deleteMany.mock.invocationCallOrder[0]);
  });

  it('does not replace the original SMTP error if cleanup fails', async () => {
    sendEmail.mockRejectedValueOnce(new Error('Original SMTP failure'));
    deleteMany.mockRejectedValueOnce(new Error('Cleanup unavailable'));
    await expect(issueRegistrationVerification(input)).rejects.toThrow('Original SMTP failure');
    expect(deleteMany).toHaveBeenCalledOnce();
  });

  it('refuses an untrusted origin before writing to the database or sending', async () => {
    await expect(issueRegistrationVerification({ ...input, siteOrigin: 'http://billok.ru' })).rejects.toThrow(
      'Не задан корректный адрес BillOK',
    );
    expect(create).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
