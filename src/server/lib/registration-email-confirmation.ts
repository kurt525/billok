import type { PrismaClient } from '@/generated/prisma/client';
import { hashEmailVerificationToken } from './email-verification-token';
import { redeemReservedSystemInvite } from './invite-redemption';
import { runRegistrationCleanupIfDue } from './registration-cleanup-trigger';

type ConfirmationDb = Pick<PrismaClient, '$transaction' | 'systemInvite' | 'emailVerificationRequest'>;

class InvalidEmailConfirmation extends Error {}

/**
 * Atomically consume a registration confirmation token and its reserved invitation.
 * An unverified account must not become verified without redeeming its own valid
 * invitation. This service is not exposed as a public route until registration
 * and sign-in enforce the same invite-only contract.
 */
export async function confirmRegistrationEmail(
  db: ConfirmationDb,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  // randomBytes(32).toString('base64url') produces exactly 43 characters.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;

  let confirmed: boolean;
  try {
    confirmed = await db.$transaction(async (tx) => {
      const request = await tx.emailVerificationRequest.findUnique({
        where: { tokenHash: hashEmailVerificationToken(token) },
        select: { id: true, userId: true, consumedAt: true, expiresAt: true },
      });
      if (!request || request.consumedAt || request.expiresAt <= now) return false;

      const invitation = await tx.systemInvite.findFirst({
        where: {
          reservedById: request.userId,
          reservedUntil: { gt: now },
          usedById: null,
          usedAt: null,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { code: true },
      });
      if (!invitation) return false;

      const consumed = await tx.emailVerificationRequest.updateMany({
        where: {
          id: request.id,
          userId: request.userId,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new InvalidEmailConfirmation();

      const updated = await tx.user.updateMany({
        where: { id: request.userId, emailVerified: null },
        data: { emailVerified: now },
      });
      if (updated.count !== 1) throw new InvalidEmailConfirmation();

      const redeemed = await redeemReservedSystemInvite(tx, {
        code: invitation.code,
        userId: request.userId,
        now,
      });
      if (!redeemed) throw new InvalidEmailConfirmation();

      return true;
    });
  } catch (error) {
    // Throwing inside the transaction rolls back both the token and user update
    // if an invite disappears or a concurrent confirmation wins the race.
    if (error instanceof InvalidEmailConfirmation) return false;
    throw error;
  }

  // Only after commit: never delete the token or release its reservation while
  // this transaction is still verifying it. Cleanup is throttled/best-effort.
  if (confirmed) await runRegistrationCleanupIfDue(db);
  return confirmed;
}
