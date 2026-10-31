import type { SMTPTransportOptions } from 'nodemailer';
import type { PrismaClient } from '@/generated/prisma/client';
import { logger } from './logger';
import { prepareRegistrationVerificationLink } from './registration-verification-link';
import { sendRussianRegistrationVerificationEmail } from './email-verification-email';

/**
 * Save only the confirmation hash before sending its one-time link.
 * Call this for an already-created, unverified account after invitation reservation.
 * Invitation consumption and sign-in restrictions belong to a separate step.
 */
export async function issueRegistrationVerification(input: {
  db: Pick<PrismaClient, 'emailVerificationRequest'>;
  userId: string;
  email: string;
  siteOrigin: string;
  from: string;
  server: SMTPTransportOptions;
}): Promise<{ expiresAt: Date }> {
  const { url, tokenHash, expiresAt } = prepareRegistrationVerificationLink(input.siteOrigin);
  const request = await input.db.emailVerificationRequest.create({
    data: { userId: input.userId, tokenHash, expiresAt },
    select: { id: true },
  });

  try {
    await sendRussianRegistrationVerificationEmail({
      to: input.email,
      url,
      from: input.from,
      server: input.server,
    });
  } catch (error) {
    // A failed SMTP send must not leave the newly issued link valid.
    // A cleanup failure must not mask the original SMTP error.
    try {
      await input.db.emailVerificationRequest.deleteMany({
        where: { id: request.id, userId: input.userId, consumedAt: null },
      });
    } catch {
      logger.error('auth.email_verification_cleanup_failed', { requestId: request.id });
    }
    throw error;
  }

  return { expiresAt };
}
