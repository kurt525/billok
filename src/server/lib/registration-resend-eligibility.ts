import type { PrismaClient } from '@/generated/prisma/client';
import { activeSystemInviteWindow } from './system-invite-lifetime';
import { findUsersByEmail } from './user-email';
import { isAllowedRegistrationEmailDomain } from './registration-email-domain';

/**
 * Locate an unverified invite-only password account with one live invitation
 * reservation. This helper is internal: never expose the account, invite code,
 * or existence of a matching email to an unauthenticated request.
 *
 * The later resend transaction MUST conditionally recheck the invitation,
 * reservation ownership and verification status before issuing a new token:
 * this initial read is not a concurrency lock.
 */
export async function findPendingRegistrationForResend(
  db: PrismaClient,
  email: string,
  now: Date = new Date(),
): Promise<{ userId: string; email: string; inviteCode: string } | null> {
  // Exactly one case-insensitive account: no guessing among duplicates.
  const users = await findUsersByEmail(db, email);
  if (users.length !== 1) return null;
  const [user] = users;
  if (
    !user ||
    !user.registrationEmailVerificationRequired ||
    user.emailVerified !== null ||
    user.passwordHash === null ||
    !isAllowedRegistrationEmailDomain(user.email)
  ) {
    return null;
  }

  const invites = await db.systemInvite.findMany({
    where: {
      reservedById: user.id,
      reservedUntil: { gt: now },
      reservedBy: {
        is: { id: user.id, emailVerified: null, registrationEmailVerificationRequired: true },
      },
      usedById: null,
      usedAt: null,
      revokedAt: null,
      ...activeSystemInviteWindow(now),
    },
    select: { code: true },
    take: 2,
  });
  if (invites.length !== 1) return null;

  return { userId: user.id, email: user.email, inviteCode: invites[0]!.code };
}
