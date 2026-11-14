import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';

/**
 * Internal recovery finalization step ONLY. A public HTTP handler must never
 * call this without verifying a one-time email token and a new signed WebAuthn attestation.
 * All writes are in one database transaction so a failed operation cannot
 * leave a half-revoked account.
 */
export async function revokeAccountAuthenticationState(input: {
  db: PrismaClient;
  userId: string;
}): Promise<{ revoked: true }> {
  if (!input.userId.trim()) throw new AppError('FORBIDDEN');
  return input.db.$transaction((tx) => revokeAccountAuthenticationStateInTransaction(tx, input.userId));
}

/** Recovery has already entered an account-level transaction. Reuse the same
 * invalidation there, never commit the new key before revoked sessions. */
export async function revokeAccountAuthenticationStateInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{ revoked: true }> {
  if (!userId.trim()) throw new AppError('FORBIDDEN');

  // Locks the user row, ordering recovery operations for this account.
  await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', userId);
  const changed = await tx.user.updateMany({
    where: { id: userId },
    data: { sessionSecurityVersion: { increment: 1 } },
  });
  if (changed.count !== 1) throw new AppError('FORBIDDEN');

  // Remove any unused WebAuthn requests and signed, one-time login tickets
  // that were already associated with the account.
  await tx.webAuthnChallenge.deleteMany({ where: { userId } });
  await tx.passkeyLoginTicket.deleteMany({ where: { userId } });
  // NextAuth currently uses JWT, but invalidate old DB-backed sessions too.
  await tx.session.deleteMany({ where: { userId } });
  return { revoked: true };
}
