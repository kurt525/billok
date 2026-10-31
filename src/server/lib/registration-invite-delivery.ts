import type { PrismaClient } from '@/generated/prisma/client';
import type { SMTPTransportOptions } from 'nodemailer';
import { logger } from './logger';
import { issueRegistrationVerification } from './registration-verification-issue';
import { createPendingInviteRegistration } from './pending-invite-registration';

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

/**
 * Prepare a password account with an invite, then issue its confirmation email.
 * On failed delivery the new unverified account is removed so its email can be
 * used for a fresh registration attempt. Deleting User cascades its email tokens
 * and releases any remaining invite reservation through the schema relations.
 *
 * Never delete an account that managed to verify between SMTP's error and the
 * compensation attempt. This helper does not authorize sign-in and is not yet
 * connected to the public registration mutation.
 */
export async function createAndDeliverPendingInviteRegistration(input: {
  db: PrismaClient;
  name: string;
  email: string;
  passwordHash: string;
  inviteCode: string;
  siteOrigin: string;
  from: string;
  server: SMTPTransportOptions;
}): Promise<{ email: string; expiresAt: Date }> {
  const user = await createPendingInviteRegistration(input.db, {
    name: input.name,
    email: input.email,
    passwordHash: input.passwordHash,
    inviteCode: input.inviteCode,
  });

  try {
    const { expiresAt } = await issueReservedInviteVerification({
      db: input.db,
      inviteCode: input.inviteCode,
      userId: user.id,
      email: user.email,
      siteOrigin: input.siteOrigin,
      from: input.from,
      server: input.server,
    });
    return { email: user.email, expiresAt };
  } catch (error) {
    try {
      // Do not retain an unverified account (and its unique email address)
      // if confirmation mail could not be issued.
      await input.db.user.deleteMany({
        where: { id: user.id, emailVerified: null },
      });
    } catch {
      logger.error('auth.pending_registration_cleanup_failed', { userId: user.id });
    }
    throw error;
  }
}
