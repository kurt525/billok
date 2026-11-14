import type { PrismaClient } from '@/generated/prisma/client';
import { renewOwnedSystemInvite } from './invite-reservation';
import { prepareRegistrationVerificationLink } from './registration-verification-link';

/**
 * Atomically renew an existing invitation lease and persist a new one-time
 * token digest for a previously vetted pending registration.
 *
 * Fails closed if the reservation has expired, was released, or was claimed by
 * someone else. The atomic UPDATE rechecks ownership and email verification
 * independently of an earlier eligibility read.
 *
 * Old confirmation tokens intentionally remain usable until successful SMTP
 * delivery and a separate finalization step. This helper does not send mail,
 * create a session or expose a public endpoint.
 */
export async function preparePendingVerificationResend(
  db: Pick<PrismaClient, '$transaction'>,
  input: { userId: string; inviteCode: string; siteOrigin: string; now?: Date },
): Promise<{ requestId: string; url: string; expiresAt: Date } | null> {
  const now = input.now ?? new Date();
  const { url, tokenHash, expiresAt } = prepareRegistrationVerificationLink(input.siteOrigin, now);

  return db.$transaction(async (tx) => {
    const renewed = await renewOwnedSystemInvite(tx, {
      code: input.inviteCode,
      userId: input.userId,
      now,
    });
    if (!renewed) return null;

    const request = await tx.emailVerificationRequest.create({
      data: { userId: input.userId, tokenHash, expiresAt },
      select: { id: true },
    });

    return { requestId: request.id, url, expiresAt };
  });
}
