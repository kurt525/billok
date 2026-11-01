import type { SMTPTransportOptions } from 'nodemailer';
import type { PrismaClient } from '@/generated/prisma/client';
import { logger } from './logger';
import { sendRussianRegistrationVerificationEmail } from './email-verification-email';
import { preparePendingVerificationResend } from './registration-resend-preparation';

/**
 * Deliver a newly prepared one-time confirmation link only to a pre-vetted
 * pending account. SMTP errors discard that new token row, without revoking
 * the previous confirmation links or releasing the invitation reservation.
 *
 * This internal helper is not a public API. The calling endpoint must enforce
 * global/IP/email limits, mask account existence and avoid logging tokens.
 */
export async function deliverPendingVerificationResend(input: {
  db: Pick<PrismaClient, '$transaction' | 'emailVerificationRequest'>;
  userId: string;
  inviteCode: string;
  email: string;
  siteOrigin: string;
  from: string;
  server: SMTPTransportOptions;
}): Promise<{ requestId: string; expiresAt: Date } | null> {
  const prepared = await preparePendingVerificationResend(input.db, {
    userId: input.userId,
    inviteCode: input.inviteCode,
    siteOrigin: input.siteOrigin,
  });
  if (!prepared) return null;

  try {
    await sendRussianRegistrationVerificationEmail({
      to: input.email,
      url: prepared.url,
      from: input.from,
      server: input.server,
    });
  } catch (error) {
    // Never delete earlier tokens, even if SMTP reports a partial failure.
    // A concurrent confirmation may consume the row: only delete an unused one.
    try {
      await input.db.emailVerificationRequest.deleteMany({
        where: { id: prepared.requestId, userId: input.userId, consumedAt: null },
      });
    } catch {
      // Preserve the original delivery error; do not log email or raw token.
      logger.error('auth.registration_resend_token_cleanup_failed', { requestId: prepared.requestId });
    }
    throw error;
  }

  // Finalization of older tokens is a separate step after SMTP success.
  // Deliberately do not return the secret confirmation URL.
  return { requestId: prepared.requestId, expiresAt: prepared.expiresAt };
}
