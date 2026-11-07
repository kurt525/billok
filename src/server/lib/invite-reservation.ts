import type { PrismaClient } from '@/generated/prisma/client';
import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from './email-verification-token';

/**
 * Atomically reserve a currently available single-use invitation.
 *
 * One conditional UPDATE prevents two concurrent registrations from taking
 * the same code. No usedById / usedAt mutation occurs before verification.
 * The caller must ensure userId is a real, unverified user in the same
 * registration transaction and must not sign in until email is verified.
 */
export async function reserveSystemInvite(
  db: Pick<PrismaClient, 'systemInvite'>,
  input: { code: string; userId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const reservedUntil = new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS);
  const result = await db.systemInvite.updateMany({
    where: {
      code: input.code,
      usedAt: null,
      usedById: null,
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ reservedUntil: null }, { reservedUntil: { lte: now } }] },
      ],
    },
    data: { reservedById: input.userId, reservedUntil },
  });
  return result.count === 1;
}

/**
 * Extend ONLY an existing invitation reservation owned by the same pending
 * invite-only account. Never reactivate used/revoked/expired invites or
 * reassign an invitation that was released or claimed by somebody else.
 *
 * This is an internal primitive, not a public resend endpoint. The caller
 * must enforce independent rate limits and generic non-enumerating responses.
 */
export async function renewOwnedSystemInvite(
  db: Pick<PrismaClient, 'systemInvite'>,
  input: { code: string; userId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await db.systemInvite.updateMany({
    where: {
      code: input.code,
      reservedById: input.userId,
      // A freed or already-expired lease cannot be resurrected for a
      // pending account: another registrant may have claimed the code.
      reservedUntil: { gt: now },
      reservedBy: {
        is: { id: input.userId, emailVerified: null, registrationEmailVerificationRequired: true },
      },
      usedById: null,
      usedAt: null,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: { reservedUntil: new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS) },
  });
  return result.count === 1;
}
