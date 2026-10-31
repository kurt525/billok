import type { PrismaClient } from '@/generated/prisma/client';

/**
 * Safe, idempotent cleanup for expired confirmation links and invitation leases.
 * This does not delete accounts, consume invites, or touch valid reservations.
 *
 * The caller schedules or triggers this operation; merely importing it does
 * not alter production behavior. A failed cleanup can be retried safely.
 */
export async function cleanupExpiredRegistrationRequests(
  db: Pick<PrismaClient, 'systemInvite' | 'emailVerificationRequest'>,
  now: Date = new Date(),
): Promise<{ releasedReservations: number; deletedTokens: number }> {
  // Conditional UPDATE: never clear a reservation that is still valid or
  // an invite already consumed by a confirmed account.
  const leases = await db.systemInvite.updateMany({
    where: {
      reservedById: { not: null },
      reservedUntil: { lte: now },
      usedById: null,
      usedAt: null,
    },
    data: { reservedById: null, reservedUntil: null },
  });

  // A token at its expiry boundary can no longer verify an email.
  // Deletion is separate from account cleanup: unverified user records remain.
  const requests = await db.emailVerificationRequest.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  return {
    releasedReservations: leases.count,
    deletedTokens: requests.count,
  };
}
