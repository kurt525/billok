/**
 * Issue #1 6.13.1: verify actual Prisma-generated User.id in isolated
 * PostgreSQL, including stable references across profile/session changes.
 * All inserted rows are rolled back. Never run this against working data.
 */
import assert from 'node:assert/strict';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROLLBACK = 'BILLOK_QA_UUID4_ROLLBACK';

async function main(): Promise<void> {
  if (process.env.BILLOK_QA_DISPOSABLE_DB !== 'I_ACKNOWLEDGE_DISPOSABLE_DB')
    throw new Error('UUIDv4 QA requires explicit disposable DB acknowledgement');
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgresql:\/\/[^/]+@127\.0\.0\.1:[0-9]+\/billokqa(?:\?|$)/u.test(url))
    throw new Error('UUIDv4 QA requires a local-only billokqa PostgreSQL URL');

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    // The CI runs this BEFORE its demo user seed. Do not delete any rows.
    assert.equal(await db.user.count(), 0, 'UUIDv4 QA requires a clean disposable user table');
    let rolledBack = false;
    try {
      await db.$transaction(async (tx) => {
        const ids = new Set<string>();
        let firstId = '';
        let secondId = '';
        for (let i = 0; i < 32; i++) {
          const user = await tx.user.create({
            data: {
              email: 'uuid4-check-' + i + '@qa.billok.ru',
              name: 'UUIDv4 QA ' + i,
              registrationEmailVerificationRequired: true,
            },
            select: { id: true },
          });
          assert.match(user.id, UUID_V4, 'Prisma User.create must mint an unpredictable UUIDv4');
          assert.ok(!ids.has(user.id), 'Duplicate User.id');
          ids.add(user.id);
          if (i === 0) firstId = user.id;
          if (i === 1) secondId = user.id;
        }

        const group = await tx.group.create({
          data: {
            name: 'Изолированная проверка UUIDv4',
            members: {
              create: [
                { userId: firstId, role: 'OWNER' },
                { userId: secondId, role: 'MEMBER' },
              ],
            },
          },
        });
        const updated = await tx.user.update({
          where: { id: firstId },
          data: {
            name: 'Обновлённое имя',
            email: 'uuid4-renamed@qa.billok.ru',
            sessionSecurityVersion: { increment: 1 },
            suspendedAt: new Date(),
          },
        });
        assert.equal(updated.id, firstId, 'Profile/recovery/session changes cannot regenerate User.id');
        assert.equal(
          (
            await tx.groupMember.findUniqueOrThrow({
              where: { userId_groupId: { userId: firstId, groupId: group.id } },
            })
          ).userId,
          firstId,
          'GroupMember foreign key must survive User updates',
        );
        assert.equal(
          (
            await tx.groupMember.findUniqueOrThrow({
              where: { userId_groupId: { userId: secondId, groupId: group.id } },
            })
          ).userId,
          secondId,
        );
        assert.equal(await tx.user.count(), 32);
        // This intentional failure rolls back ALL synthetic users and group records.
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if (error instanceof Error && error.message === ROLLBACK) rolledBack = true;
      else throw error;
    }
    assert.ok(rolledBack, 'QA transaction did not roll back');
    assert.equal(await db.user.count(), 0, 'QA rows leaked outside the transaction');
    assert.equal(
      await db.group.count({ where: { name: 'Изолированная проверка UUIDv4' } }),
      0,
      'QA group leaked outside the transaction',
    );
    console.log('BILLOK_USER_UUIDV4_POSTGRES=PASS');
  } finally {
    await db.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name + ': ' + error.message : 'UUIDv4 QA failed');
  process.exitCode = 1;
});
