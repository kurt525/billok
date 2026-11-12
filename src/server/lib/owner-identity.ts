import type { PrismaClient } from '@/generated/prisma/client';

/**
 * Issue #1 6.12.1 — The ONLY source of current owner authority is the
 * completed, fixed-key OwnerBootstrap row. ADMIN_EMAIL is for the operator's
 * ONE-TIME initial bootstrap, NEVER authorization after registration.
 *
 * No JWT flags, email matches, client-supplied user IDs or cookies can turn
 * another session into an owner.
 */
export async function completedOwnerUserId(db: Pick<PrismaClient, 'ownerBootstrap'>): Promise<string | null> {
  const owner = await db.ownerBootstrap.findUnique({
    where: { id: 1 },
    select: { userId: true, completedAt: true },
  });
  return owner?.completedAt ? owner.userId : null;
}

export async function isCompletedOwner(
  db: Pick<PrismaClient, 'ownerBootstrap'>,
  candidateUserId: string | null | undefined,
): Promise<boolean> {
  if (!candidateUserId) return false;
  return (await completedOwnerUserId(db)) === candidateUserId;
}
