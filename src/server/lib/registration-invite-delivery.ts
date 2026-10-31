import type { PrismaClient } from '@/generated/prisma/client';
import type { SMTPTransportOptions } from 'nodemailer';
import { logger } from './logger';
import { issueRegistrationVerification } from './registration-verification-issue';

/**
 * For an already-reserved invitation, deliver the email confirmation link.
 * Failure releases ONLY this user's unconsumed reservation, allowing retry.
 * The user and lease must have been created atomically by the caller.
 */
export async function issueReservedInviteVerification(input: {
  db: Pick<PrismaClient, 'emailVerificationRequest' | 'systemInvite'>;
  inviteCode: string;
  userId: string;
  email: string;
  siteOrigin: string;
  from: string;
  server: SMTPTransportOptions;
}): Promise<{ expiresAt: Date }> {
  try {
    return await issueRegistrationVerification(input);
  } catch (error) {
    // Keep the failure visible even when best-effort cleanup itself fails.
    // A userId/code conditional update must not release another user's lease
    // if this invite has already been reclaimed after an expiry.
    try {
      await input.db.systemInvite.updateMany({
        where: {
          code: input.inviteCode,
          reservedById: input.userId,
          usedById: null,
          usedAt: null,
        },
        data: { reservedById: null, reservedUntil: null },
      });
    } catch {
      logger.error('auth.invite_reservation_release_failed', { userId: input.userId });
    }
    throw error;
  }
}
