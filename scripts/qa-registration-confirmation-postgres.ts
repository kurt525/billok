/**
 * One high-value integration check against the disposable CI PostgreSQL.
 * Unit mocks cannot demonstrate that two concurrent confirmations cannot
 * consume the same database token/invitation.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { createEmailVerificationToken } from '../src/server/lib/email-verification-token';
import { confirmRegistrationEmail } from '../src/server/lib/registration-email-confirmation';
import { createPendingInviteRegistration } from '../src/server/lib/pending-invite-registration';
import { SYSTEM_INVITE_TTL_MS } from '../src/server/lib/system-invite-lifetime';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('QA PostgreSQL DATABASE_URL is required');

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const now = new Date();
  const suffix = randomBytes(9).toString('hex');
  const inviteCode = 'ci-confirm-' + suffix;
  const { token, tokenHash, expiresAt } = createEmailVerificationToken(now);
  let userId: string | null = null;

  try {
    // 6.2: disposable QA invitations must obey the same strict seven-day
    // validity window as invitations created by the administrator.
    const inviteExpiresAt = new Date(now.getTime() + SYSTEM_INVITE_TTL_MS);
    const testInvite = await db.systemInvite.create({
      data: { code: inviteCode, expiresAt: inviteExpiresAt },
    });
    assert.equal(testInvite.expiresAt?.getTime(), inviteExpiresAt.getTime(), 'QA invitation has a seven-day expiry');
    const user = await createPendingInviteRegistration(db, {
      name: 'Проверка подтверждения',
      email: 'ci-confirm-' + suffix + '@billok.ru',
      inviteCode,
      now,
    });
    userId = user.id;

    const pending = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const reserved = await db.systemInvite.findUniqueOrThrow({ where: { code: inviteCode } });
    assert.equal(pending.emailVerified, null, 'account stays unverified before confirmation');
    assert.equal(reserved.reservedById, user.id, 'invitation is reserved for this account');
    assert.equal(reserved.usedById, null, 'registration must not consume invitation');

    await db.emailVerificationRequest.create({
      data: { userId: user.id, tokenHash, expiresAt },
    });

    // Two requests race for the same token. Exactly one may complete.
    const answers = await Promise.all([
      confirmRegistrationEmail(db, token, now),
      confirmRegistrationEmail(db, token, now),
    ]);
    assert.deepEqual(answers.sort(), [false, true], 'only one concurrent confirmation may succeed');

    const [account, invite, verification] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: user.id } }),
      db.systemInvite.findUniqueOrThrow({ where: { code: inviteCode } }),
      db.emailVerificationRequest.findUniqueOrThrow({ where: { tokenHash } }),
    ]);
    assert.ok(account.emailVerified, 'email is verified');
    assert.equal(invite.usedById, user.id, 'only the owner redeemed the invitation');
    assert.ok(invite.usedAt, 'invitation marked used');
    assert.equal(invite.reservedById, null, 'reservation released after redemption');
    assert.ok(verification.consumedAt, 'verification token consumed');

    assert.equal(await confirmRegistrationEmail(db, token, now), false, 'replayed link must not verify twice');
    console.log('POSTGRES_REGISTRATION_CONFIRMATION=PASS');
  } finally {
    if (userId) {
      await db.emailVerificationRequest.deleteMany({ where: { userId } });
      await db.systemInvite.deleteMany({ where: { code: inviteCode } });
      await db.user.deleteMany({ where: { id: userId } });
    }
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
