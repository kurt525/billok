/**
 * Fixtures only for the disposable PostgreSQL created by BillOK Chromium CI.
 * No secrets or test accounts are written to the normal deployment.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { hashEmailVerificationToken } from '../src/server/lib/email-verification-token';
import { hashPasswordResetToken } from '../src/server/lib/password-reset-token';
import { SYSTEM_INVITE_TTL_MS } from '../src/server/lib/system-invite-lifetime';

async function main() {
  if (process.env.BILLOK_QA_FIXTURES !== '1') throw new Error('QA fixture opt-in is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/billokqa') {
    throw new Error('Refusing to change a non-disposable database');
  }

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
  const unique = randomBytes(8).toString('hex');
  const ruCode = 'qa-ru-' + unique;
  const suCode = 'qa-su-' + unique;
  const expiredToken = 'E'.repeat(43);
  const expiredResetToken = 'F'.repeat(43);

  try {
    await db.systemSetting.upsert({
      where: { key: 'registrationMode' },
      update: { value: 'invite-only' },
      create: { key: 'registrationMode', value: 'invite-only' },
    });
    // Invite-only QA accounts must use the same strict seven-day expiry
    // as administrator-created invitations (Issue #1 6.2).
    const expiresAt = new Date(Date.now() + SYSTEM_INVITE_TTL_MS);
    await db.systemInvite.createMany({
      data: [
        { code: ruCode, expiresAt },
        { code: suCode, expiresAt },
      ],
    });
    const pending = await db.user.create({
      data: {
        name: 'Истёкшая регистрация QA',
        email: 'expired-' + unique + '@mail.ru',
        passwordHash: await bcrypt.hash('expired-password-123', 10),
        emailVerified: null,
        registrationEmailVerificationRequired: true,
      },
    });
    await db.emailVerificationRequest.create({
      data: {
        userId: pending.id,
        tokenHash: hashEmailVerificationToken(expiredToken),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const existing = await db.user.create({
      data: {
        name: 'Истёкший сброс QA',
        email: 'reset-expired-' + unique + '@mail.su',
        passwordHash: await bcrypt.hash('old-password-123', 10),
        emailVerified: new Date(),
        registrationEmailVerificationRequired: false,
      },
    });
    await db.passwordResetRequest.create({
      data: {
        userId: existing.id,
        tokenHash: hashPasswordResetToken(expiredResetToken),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    process.stdout.write('BILLOK_QA_AUTH_INVITE_RU=' + ruCode + '\n');
    process.stdout.write('BILLOK_QA_AUTH_INVITE_SU=' + suCode + '\n');
    process.stdout.write('BILLOK_QA_EXPIRED_CONFIRM=' + expiredToken + '\n');
    process.stdout.write('BILLOK_QA_EXPIRED_RESET=' + expiredResetToken + '\n');
  } finally {
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error('Disposable auth journey fixtures failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
