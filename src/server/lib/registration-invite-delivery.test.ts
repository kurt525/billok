import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';

const { deliver, pendingRegistration } = vi.hoisted(() => ({ deliver: vi.fn(), pendingRegistration: vi.fn() }));
vi.mock('./pending-invite-registration', () => ({ createPendingInviteRegistration: pendingRegistration }));
vi.mock('./registration-verification-issue', () => ({ issueRegistrationVerification: deliver }));

import {
  createAndDeliverPendingInviteRegistration,
  issueReservedInviteVerification,
} from './registration-invite-delivery';

const updateMany = vi.fn();
const deletePendingUser = vi.fn();
const db = {
  systemInvite: { updateMany },
  emailVerificationRequest: {},
  user: { deleteMany: deletePendingUser },
} as unknown as Pick<PrismaClient, 'emailVerificationRequest' | 'systemInvite'>;

const input = {
  db,
  inviteCode: 'invite-test',
  userId: 'new-account-1',
  email: 'user@example.ru',
  siteOrigin: 'https://billok.ru',
  from: 'BillOK <noreply@billok.ru>',
  server: { host: 'smtp.example.test', port: 587 },
};

beforeEach(() => {
  vi.clearAllMocks();
  deliver.mockResolvedValue({ expiresAt: new Date('2026-10-31T10:30:00.000Z') });
  updateMany.mockResolvedValue({ count: 1 });
  deletePendingUser.mockResolvedValue({ count: 1 });
  pendingRegistration.mockResolvedValue({ id: input.userId, name: 'Тест', email: input.email });
});

describe('confirmation delivery for reserved invitations', () => {
  it('sends the link without clearing or consuming an invite on success', async () => {
    const result = await issueReservedInviteVerification(input);
    expect(deliver).toHaveBeenCalledExactlyOnceWith(input);
    expect(result.expiresAt.toISOString()).toBe('2026-10-31T10:30:00.000Z');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('releases only the same user unconsumed reservation if delivery fails', async () => {
    deliver.mockRejectedValueOnce(new Error('SMTP failed'));
    await expect(issueReservedInviteVerification(input)).rejects.toThrow('SMTP failed');
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        code: 'invite-test',
        reservedById: 'new-account-1',
        usedById: null,
        usedAt: null,
      },
      data: { reservedById: null, reservedUntil: null },
    });
  });

  it('preserves the original delivery failure when release fails', async () => {
    deliver.mockRejectedValueOnce(new Error('Mail service unreachable'));
    updateMany.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(issueReservedInviteVerification(input)).rejects.toThrow('Mail service unreachable');
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it('does not claim to have issued a link after a failed delivery with a reclaimed reservation', async () => {
    deliver.mockRejectedValueOnce(new Error('Confirmation failed'));
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(issueReservedInviteVerification(input)).rejects.toThrow('Confirmation failed');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ reservedById: input.userId }) }),
    );
  });
});

describe('SMTP failure compensation after pending registration', () => {
  it('releases the invite and removes only the newly created unverified account so its email is reusable', async () => {
    deliver.mockRejectedValueOnce(new Error('SMTP rejected'));
    await expect(
      createAndDeliverPendingInviteRegistration({
        ...input,
        db: db as PrismaClient,
        name: 'Тест',
        passwordHash: 'only-for-test',
      }),
    ).rejects.toThrow('SMTP rejected');

    expect(pendingRegistration).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledOnce();
    expect(deletePendingUser).toHaveBeenCalledExactlyOnceWith({
      where: { id: input.userId, emailVerified: null },
    });
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(deletePendingUser.mock.invocationCallOrder[0]!);
  });
});
