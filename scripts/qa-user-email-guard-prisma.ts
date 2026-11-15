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
  try {
    const user = await db.user.create({ data: { id, email: normal } });
    assert.equal(user.email, normal);
    for (const [index, email] of [
      'blocked@example.com',
      'bad@domain.ru.evil.com',
      'bad@dоmain.ru',
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
    assert.equal((await db.user.findUniqueOrThrow({ where: { id } })).email, normal);
  } finally {
    await db.user.deleteMany({ where: { id } });
    assert.equal(await db.user.count(), baseline, 'Disposable Prisma QA rows leaked');
    await db.$disconnect();
  }
  console.log('USER_EMAIL_RU_SU_PRISMA_GUARD=PASS');
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'email DB guard failed');
  process.exitCode = 1;
});
