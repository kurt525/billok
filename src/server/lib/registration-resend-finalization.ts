import type { PrismaClient } from '@/generated/prisma/client';

/**
 * Invalidate only older, still-unused email confirmation links after the
 * replacement email has been accepted by SMTP. A token already consumed by a
 * concurrent confirmation is never overwritten; only links created before
 * the new token are eligible. The new and later tokens remain untouched.
 *
 * This internal helper does not send email, change invitations or log tokens.
 * A later delivery step calls it only after successful SMTP delivery.
 */
export async function finalizePendingVerificationResend(
  db: Pick<PrismaClient, 'emailVerificationRequest'>,
  input: { userId: string; requestId: string; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  const replacement = await db.emailVerificationRequest.findUnique({
    where: { id: input.requestId },
    select: { userId: true, createdAt: true, expiresAt: true, consumedAt: true },
  });
  if (
    !replacement ||
    replacement.userId !== input.userId ||
    replacement.consumedAt !== null ||
    replacement.expiresAt <= now
  ) {
    return 0;
  }

  const updated = await db.emailVerificationRequest.updateMany({
    where: {
      userId: input.userId,
      id: { not: input.requestId },
      consumedAt: null,
      createdAt: { lt: replacement.createdAt },
      user: {
        is: { id: input.userId, emailVerified: null, registrationEmailVerificationRequired: true },
      },
    },
    data: { consumedAt: now },
  });
  return updated.count;
}
