import type { PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';

/**
 * Internal recovery finalization step ONLY. A public HTTP handler must never
 * call this without verifying independent ownership proof and an email token.
 * All writes are in one database transaction so a failed operation cannot
 * leave a half-revoked account.
 */
export async function revokeAccountAuthenticationState(input: {
  db: PrismaClient;
  userId: string;
}): Promise<{ revoked: true }> {
  if (!input.userId.trim()) throw new AppError('FORBIDDEN');
  return input.db.$transaction(async (tx) => {
    // Locks the user row, ordering recovery operations for this account.
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.userId);
    const changed = await tx.user.updateMany({
      where: { id: input.userId },
      data: { sessionSecurityVersion: { increment: 1 } },
    });
    if (changed.count !== 1) throw new AppError('FORBIDDEN');

    // Remove any unused WebAuthn requests and signed, one-time login tickets
    // that were already associated with the account.
    await tx.webAuthnChallenge.deleteMany({ where: { userId: input.userId } });
    await tx.passkeyLoginTicket.deleteMany({ where: { userId: input.userId } });
    // NextAuth currently uses JWT, but invalidate old DB-backed sessions too.
    await tx.session.deleteMany({ where: { userId: input.userId } });
    return { revoked: true };
  });
}
