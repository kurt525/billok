import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('./user-email', () => ({ findUsersByEmail: lookup }));

import { findPendingRegistrationForResend } from './registration-resend-eligibility';

const now = new Date('2026-11-01T12:00:00.000Z');
const pending = {
  id: 'pending-1',
  email: 'Person@MAIL.RU',
  registrationEmailVerificationRequired: true,
  emailVerified: null as Date | null,
};
const findMany = vi.fn();
const db = { systemInvite: { findMany } } as unknown as PrismaClient;

beforeEach(() => {
  vi.clearAllMocks();
  lookup.mockResolvedValue([pending]);
  findMany.mockResolvedValue([{ code: 'invite-1' }]);
});

describe('pending registration eligibility for future resend', () => {
  it('only returns an invite for one unverified invite-only account with an active owned reservation', async () => {
    await expect(findPendingRegistrationForResend(db, 'person@mail.ru', now)).resolves.toEqual({
      userId: 'pending-1',
      email: 'Person@MAIL.RU',
      inviteCode: 'invite-1',
    });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(db, 'person@mail.ru');
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        reservedById: 'pending-1',
        reservedUntil: { gt: now },
        reservedBy: {
          is: { id: 'pending-1', emailVerified: null, registrationEmailVerificationRequired: true },
        },
        usedById: null,
        usedAt: null,
        revokedAt: null,
        createdAt: { gt: new Date(now.getTime() - 7 * 86_400_000) },
        expiresAt: { gt: now },
      },
      select: { code: true },
      take: 2,
    });
  });

  it.each([
    ['missing account', []],
    ['ambiguous email', [pending, { ...pending, id: 'duplicate' }]],
    ['confirmed account', [{ ...pending, emailVerified: now }]],
    ['legacy account', [{ ...pending, registrationEmailVerificationRequired: false }]],
    ['email outside ru and su', [{ ...pending, email: 'person@example.com' }]],
  ])('fails closed for %s without looking up invitations', async (_scenario, users) => {
    lookup.mockResolvedValueOnce(users);
    await expect(findPendingRegistrationForResend(db, pending.email, now)).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['no reservation', []],
    ['more than one matching reservation', [{ code: 'invite-1' }, { code: 'invite-2' }]],
  ])('returns null for %s without guessing an invitation', async (_scenario, invites) => {
    findMany.mockResolvedValueOnce(invites);
    await expect(findPendingRegistrationForResend(db, pending.email, now)).resolves.toBeNull();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
