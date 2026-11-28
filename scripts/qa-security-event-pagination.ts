/** TASK-BILLOK-011: real PostgreSQL, actual admin router, rollback only.
 * Run after the isolated mobile auth seed, never against a working DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { assertDisposableQaDatabase } from './qa-fixture-database';

async function main() {
  const url = assertDisposableQaDatabase(process.env);
  const { adminRouter } = await import('../src/server/trpc/routers/admin');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const prefix = 'qa-security-' + randomUUID() + '-';
  const rollback = new Error('QA_ROLLBACK');
  try {
    try {
      await db.$transaction(
        async (tx) => {
          const owner = await tx.ownerBootstrap.findUniqueOrThrow({ where: { id: 1 } });
          const ownerAccount = await tx.user.findUniqueOrThrow({ where: { id: owner.userId } });
          assert.ok(owner.completedAt);
          assert.equal(ownerAccount.email, 'owner-qa@mail.ru');
          const a = await tx.user.update({ where: { email: 'alice@qa.billok.ru' }, data: { name: 'Гость' } });
          const b = await tx.user.update({ where: { email: 'bob@qa.billok.ru' }, data: { name: 'Гость' } });
          const missing = randomUUID();
          const api = adminRouter.createCaller({
            db: tx,
            session: { user: { id: owner.userId, email: ownerAccount.email } },
            headers: new Headers(),
            impersonating: null,
            locale: 'ru',
          } as unknown as Parameters<typeof adminRouter.createCaller>[0]);
          const tied = new Date('2099-01-01T00:00:00.000Z');
          const rows = Array.from({ length: 43 }, (_, i) => ({
            id: prefix + 'match-' + String(i).padStart(3, '0'),
            actorId: i % 2 ? a.id.toUpperCase() : a.id,
            action: 'OWNER_PASSKEY_RENAMED',
            outcome: 'ALLOWED' as const,
            createdAt: tied,
          }));
          const other = Array.from({ length: 25 }, (_, i) => ({
            id: prefix + 'other-' + i,
            actorId: b.id,
            action: 'admin.deleteUser',
            outcome: 'DENIED' as const,
            createdAt: new Date('2099-02-01T00:00:00.000Z'),
          }));
          await tx.securityEvent.createMany({
            data: [
              ...rows,
              ...other,
              {
                id: prefix + 'missing',
                actorId: missing,
                action: 'AUTH_EMAIL_CONFIRM_ATTEMPT',
                outcome: 'DENIED',
                createdAt: tied,
              },
              {
                id: prefix + 'null',
                actorId: null,
                action: 'PASSKEY_RECOVERY_START',
                outcome: 'ALLOWED',
                createdAt: tied,
              },
              {
                id: prefix + 'owner',
                actorId: owner.userId,
                action: 'OWNER_APPROVAL_STARTED',
                outcome: 'ALLOWED',
                createdAt: tied,
              },
            ],
          });
          const recent = await api.getSecurityEvents({ limit: 20 });
          assert.equal(recent.items.length, 20);
          assert.ok(
            recent.items.every(
              (row) =>
                row.actorId === b.id &&
                row.actor?.name === 'Гость' &&
                row.actor.email === b.email &&
                !row.actor.isOwner,
            ),
          );
          const first = await api.getSecurityEvents({ actorId: ' ' + a.id.toUpperCase() + ' ', limit: 20 });
          assert.equal(first.items.length, 20);
          assert.ok(
            first.items.every(
              (row) => row.actor?.name === 'Гость' && row.actor.email === a.email && !row.actor.isOwner,
            ),
          );
          assert.ok(first.nextCursor);
          await assert.rejects(api.getSecurityEvents({ actorId: b.id, limit: 20, cursor: first.nextCursor }), {
            code: 'BAD_REQUEST',
          });
          await tx.securityEvent.create({
            data: { ...rows[0]!, id: prefix + 'fresh', createdAt: new Date('2100-01-01T00:00:00.000Z') },
          });
          const second = await api.getSecurityEvents({ actorId: a.id, limit: 20, cursor: first.nextCursor });
          assert.ok(second.nextCursor);
          const third = await api.getSecurityEvents({ actorId: a.id, limit: 20, cursor: second.nextCursor });
          assert.equal(third.nextCursor, undefined);
          const seen = [...first.items, ...second.items, ...third.items].map((x) => x.id);
          assert.deepEqual(seen, rows.map((x) => x.id).reverse());
          assert.equal(new Set(seen).size, 43);
          await tx.user.update({ where: { id: a.id }, data: { name: 'Новое имя QA' } });
          const renamed = await api.getSecurityEvents({ actorId: a.id, limit: 1 });
          assert.equal(renamed.items[0]?.actor?.name, 'Новое имя QA');
          assert.equal(renamed.items[0]?.actorId, a.id);
          const absent = await api.getSecurityEvents({ actorId: missing, limit: 20 });
          assert.equal(absent.items[0]?.actor, null);
          assert.equal(absent.items[0]?.actorId, missing);
          const ownerEvents = await api.getSecurityEvents({ actorId: owner.userId, limit: 20 });
          assert.ok(ownerEvents.items.find((row) => row.id === prefix + 'owner')?.actor?.isOwner);
          assert.equal((await api.getSecurityEvents({ actorId: randomUUID() })).items.length, 0);
          throw rollback;
        },
        { timeout: 20_000 },
      );
      assert.fail('Rollback was not triggered');
    } catch (error) {
      if (error !== rollback) throw error;
    }
    assert.equal(await db.securityEvent.count({ where: { id: { startsWith: prefix } } }), 0);
    console.log('REAL_POSTGRES_SECURITY_UUID_3_PAGES_INSERT_TIE_ROLLBACK=PASS');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'QA pagination failed');
  process.exitCode = 1;
});
