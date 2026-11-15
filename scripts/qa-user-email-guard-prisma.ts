/**
 * Issue #1 6.14.3: direct Prisma INSERT/UPDATE cannot bypass PostgreSQL.
 * Only a disposable localhost billokqa DB with explicit acknowledgement.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (
    process.env.BILLOK_QA_DISPOSABLE_DB !== 'I_ACKNOWLEDGE_DISPOSABLE_DB' ||
    !/^postgresql:\/\/[^/]+@127\.0\.0\.1:\d+\/billokqa(?:\?|$)/u.test(url)
  )
    throw new Error('Email DB guard QA requires isolated localhost billokqa');

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const baseline = await db.user.count();
  const suffix = randomUUID();
  const id = 'qa-email-guard-' + suffix;
  const normal = 'initial-' + suffix + '@qa.billok.ru';
  const suId = id + '-su';
  const suEmail = 'Validated-' + suffix + '@Deep.QA.Billok.SU';
  try {
    const user = await db.user.create({ data: { id, email: normal } });
    assert.equal(user.email, normal);
    const suUser = await db.user.create({ data: { id: suId, email: suEmail } });
    assert.equal(suUser.email, suEmail, 'direct Prisma accepts a permitted .su subdomain');
    for (const [index, email] of [
      'blocked@example.com',
      'blocked@example.net',
      'blocked@example.org',
      'bad@domain.ru.evil.com',
      'bad@company.su.evil.com',
      'bad@dоmain.ru',
      'bad@xn--.ru',
      'bad@domain.su.',
    ].entries()) {
      await assert.rejects(
        () => db.user.create({ data: { id: id + index, email } }),
        'Prisma User.create bypassed the PostgreSQL domain CHECK',
      );
      await assert.rejects(
        () => db.user.update({ where: { id }, data: { email } }),
        'Prisma User.update bypassed the PostgreSQL domain CHECK',
      );
    }
    await assert.rejects(
      () => db.user.create({ data: { email: normal.toUpperCase() } }),
      'Case-insensitive unique index accepted duplicate account',
    );
    await assert.rejects(
      () => db.user.create({ data: { email: suEmail.toLowerCase() } }),
      'Case-insensitive unique index accepted a .su duplicate account',
    );
    assert.equal((await db.user.findUniqueOrThrow({ where: { id } })).email, normal);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: suId } })).email, suEmail);
  } finally {
    await db.user.deleteMany({ where: { id: { in: [id, suId] } } });
    assert.equal(await db.user.count(), baseline, 'Disposable Prisma QA rows leaked');
    await db.$disconnect();
  }
  console.log('USER_EMAIL_RU_SU_PRISMA_GUARD=PASS');
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'email DB guard failed');
  process.exitCode = 1;
});
