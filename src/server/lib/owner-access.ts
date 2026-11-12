import type { PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';

/**
 * Issue #1 6.12.2 — the ONE server-side owner authorization policy.
 * Call ONLY with authenticated session user ID from auth().
 * The Auth.js JWT callback re-reads User.sessionSecurityVersion from DB
 * on each request and rejects revoked/legacy JWTs before exposing a user ID.
 * This function rechecks owner, verification, suspension and placeholder status.
 * Per-action transactional authorization remains separately in 6.12.8.
 */
export async function requireOwner(
  db: Pick<PrismaClient, 'ownerBootstrap' | 'user'>,
  authenticatedUserId: string | null | undefined,
): Promise<string> {
  if (!authenticatedUserId) throw new AppError('FORBIDDEN', 'adminRequired');
  const [record, user] = await Promise.all([
    db.ownerBootstrap.findUnique({
      where: { id: 1 },
      select: { userId: true, completedAt: true },
    }),
    db.user.findUnique({
      where: { id: authenticatedUserId },
      select: {
        emailVerified: true,
        suspendedAt: true,
        isPlaceholder: true,
        sessionSecurityVersion: true,
      },
    }),
  ]);
  if (
    !record?.completedAt ||
    record.userId !== authenticatedUserId ||
    !user?.emailVerified ||
    user.suspendedAt ||
    user.isPlaceholder ||
    !Number.isSafeInteger(user.sessionSecurityVersion) ||
    user.sessionSecurityVersion < 0
  ) {
    throw new AppError('FORBIDDEN', 'adminRequired');
  }
  return authenticatedUserId;
}
