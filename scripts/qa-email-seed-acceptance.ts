/**
 * Issue #1 6.14.6: acceptance of real, deliberately disposable seed data.
 * CI executes this ONLY after seed and before any browser auth fixtures.
 * Never open a network SMTP connection or mutate existing QA/real users.
 */
import assert from 'node:assert/strict';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { assertDisposableQaDatabase } from './qa-fixture-database';
import { normalizeAllowedRegistrationEmail } from '../src/server/lib/registration-email-domain';

async function main(): Promise<void> {
  const url = assertDisposableQaDatabase(process.env);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const expected = [
      'alice@qa.billok.ru',
      'bob@qa.billok.ru',
      'charlie@qa.billok.ru',
      'suspend-test@qa.billok.ru',
      'delete-test@qa.billok.ru',
    ];
    const users = await db.user.findMany({
      select: {
        email: true,
        emailVerified: true,
        registrationEmailVerificationRequired: true,
        passkeyCredentials: { select: { id: true }, take: 1 },
      },
      orderBy: { email: 'asc' },
    });
    assert.deepEqual(
      users.map((u) => u.email).sort(),
      expected.sort(),
      'Only the five approved QA seed addresses may exist before browser fixtures',
    );
    for (const user of users) {
      assert.equal(normalizeAllowedRegistrationEmail(user.email), user.email);
      assert.equal(user.emailVerified, null, 'QA seed alone cannot verify account ownership');
      assert.equal(user.passkeyCredentials.length, 0, 'QA seed cannot register Passkeys');
      assert.equal(user.registrationEmailVerificationRequired, false);
    }
    assert.equal(await db.passkeyLoginTicket.count(), 0, 'QA seed cannot mint session tickets');
    assert.equal(await db.emailVerificationRequest.count(), 0, 'QA seed cannot mint verification tokens');
    console.log('BILLOK_EMAIL_SEED_ACCEPTANCE=PASS');
  } finally {
    await db.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Seed acceptance failed');
  process.exitCode = 1;
});
