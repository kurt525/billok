import type { PrismaClient } from '@/generated/prisma/client';

/**
 * Atomically consume a reserved invitation only for its verified account.
 *
 * Call inside the same database transaction that confirms the email address:
 * a failed invitation claim must roll back email verification as well.
 * The Prisma relation filter is checked by the database, not by an earlier
 * application-side user lookup.
 */
export async function redeemReservedSystemInvite(
  db: Pick<PrismaClient, 'systemInvite'>,
  input: { code: string; userId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await db.systemInvite.updateMany({
    where: {
      code: input.code,
      reservedById: input.userId,
      reservedUntil: { gt: now },
      reservedBy: { is: { id: input.userId, emailVerified: { not: null } } },
      usedById: null,
      usedAt: null,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: {
      usedById: input.userId,
      usedAt: now,
      reservedById: null,
      reservedUntil: null,
    },
  });
  return result.count === 1;
}
