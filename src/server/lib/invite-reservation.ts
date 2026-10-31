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
