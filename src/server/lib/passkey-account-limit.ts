import type { Prisma } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { OWNER_BOOTSTRAP_SINGLETON_ID } from './owner-bootstrap';

export const REGULAR_PASSKEY_LIMIT = 1;
export const OWNER_PASSKEY_LIMIT = 3;

/**
 * Must be called inside the SAME PostgreSQL transaction as Passkey creation.
 * Serialize concurrent ceremonies using a row lock on the account itself,
 * so separate registration requests cannot both observe a free key slot.
 *
 * Only a completed owner bootstrap can add a second/third Passkey. Email
 * confirmation, an invite, or an impersonated session cannot authorize
 * additional keys. A separate signed re-verification is required upstream
 * for the later OWNER_ADDITIONAL flow (Issue #1 6.10.2.2–6.10.2.3).
 */
export async function assertPasskeyEnrollmentCapacity(
  tx: Prisma.TransactionClient,
  userId: string,
  purpose: 'FIRST' | 'OWNER_ADDITIONAL',
): Promise<{ maxActive: 1 | 3; activeCount: number }> {
  if (!userId.trim()) throw new AppError('FORBIDDEN');
  const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id FROM "User" WHERE id = $1 FOR UPDATE',
    userId,
  );
  if (locked.length !== 1) throw new AppError('FORBIDDEN');

  const owner = await tx.ownerBootstrap.findUnique({
    where: { id: OWNER_BOOTSTRAP_SINGLETON_ID },
    select: { userId: true, completedAt: true },
  });
  const isCompletedOwner = owner?.userId === userId && Boolean(owner.completedAt);
  if (purpose === 'OWNER_ADDITIONAL' && !isCompletedOwner) throw new AppError('FORBIDDEN');

  // The *initial* owner key is subject to the same one-key first registration
  // invariant; only after completion may the owner opt into 2–3 total keys.
  const maxActive: 1 | 3 = isCompletedOwner ? OWNER_PASSKEY_LIMIT : REGULAR_PASSKEY_LIMIT;
  const activeCount = await tx.passkeyCredential.count({
    where: { userId, revokedAt: null },
  });
  if (activeCount >= maxActive || (purpose === 'FIRST' && activeCount !== 0)) {
    throw new AppError('FORBIDDEN');
  }
  return { maxActive, activeCount };
}
