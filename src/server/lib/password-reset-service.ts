import bcrypt from 'bcryptjs';
import type { SMTPTransportOptions } from 'nodemailer';
import type { PrismaClient } from '@/generated/prisma/client';
import { findUsersByEmail } from './user-email';
import { logger } from './logger';
import { preparePasswordResetLink, hashPasswordResetToken } from './password-reset-token';
import { sendRussianPasswordResetEmail } from './password-reset-email';

export async function issuePasswordReset(input: {
  db: PrismaClient; email: string; siteOrigin: string; from: string; server: SMTPTransportOptions;
}): Promise<void> {
  const users = await findUsersByEmail(input.db, input.email);
  if (users.length !== 1) return;
  const user = users[0]!;
  if (!user.emailVerified || !user.passwordHash || user.suspendedAt || user.isPlaceholder) return;
  const { url, tokenHash, expiresAt } = preparePasswordResetLink(input.siteOrigin);
  const request = await input.db.passwordResetRequest.create({
    data: { userId: user.id, tokenHash, expiresAt },
    select: { id: true, createdAt: true },
  });
  try {
    await sendRussianPasswordResetEmail({ to: user.email, url, from: input.from, server: input.server });
  } catch (error) {
    try {
      await input.db.passwordResetRequest.deleteMany({
        where: { id: request.id, userId: user.id, consumedAt: null },
      });
    } catch {
      logger.error('auth.password_reset_cleanup_failed', { requestId: request.id });
    }
    throw error;
  }
  try {
    await input.db.passwordResetRequest.updateMany({
      where: {
        userId: user.id, id: { not: request.id },
        createdAt: { lt: request.createdAt }, consumedAt: null,
      },
      data: { consumedAt: new Date() },
    });
  } catch {
    logger.error('auth.password_reset_finalization_failed', { requestId: request.id });
  }
}

class ConcurrentPasswordReset extends Error {}

/** Consume a token and update the password atomically, with rollback on any conflict. */
export async function redeemPasswordReset(
  db: Pick<PrismaClient, '$transaction'>, token: string, newPassword: string, now: Date = new Date(),
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  try {
    return await db.$transaction(async (tx) => {
      const request = await tx.passwordResetRequest.findUnique({
        where: { tokenHash: hashPasswordResetToken(token) },
        select: { id: true, userId: true, consumedAt: true, expiresAt: true },
      });
      if (!request || request.consumedAt || request.expiresAt <= now) return false;
      const user = await tx.user.findUnique({
        where: { id: request.userId },
        select: { id: true, emailVerified: true, passwordHash: true, suspendedAt: true, isPlaceholder: true },
      });
      if (!user?.emailVerified || !user.passwordHash || user.suspendedAt || user.isPlaceholder) return false;

      const hash = await bcrypt.hash(newPassword, 12);
      const consumed = await tx.passwordResetRequest.updateMany({
        where: { id: request.id, userId: request.userId, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new ConcurrentPasswordReset();
      const updated = await tx.user.updateMany({
        where: {
          id: request.userId,
          emailVerified: { not: null }, passwordHash: { not: null },
          suspendedAt: null, isPlaceholder: false,
        },
        data: { passwordHash: hash },
      });
      if (updated.count !== 1) throw new ConcurrentPasswordReset();
      await tx.passwordResetRequest.updateMany({
        where: { userId: request.userId, id: { not: request.id }, consumedAt: null },
        data: { consumedAt: now },
      });
      return true;
    });
  } catch (error) {
    if (error instanceof ConcurrentPasswordReset) return false;
    throw error;
  }
}
