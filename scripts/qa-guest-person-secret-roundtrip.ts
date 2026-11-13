/**
 * CI disposable PostgreSQL: real Prisma client extension, raw on-disk JSON,
 * authenticated read and atomic per-receipt rotation. Not a production script.
 */
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { db } from '../src/server/db';
import { issueGuestPersonToken } from '../src/server/lib/guest-person-secret';
import { issueGuestShareLink } from '../src/server/lib/guest-share-link';

async function main() {
  if (!process.env.BILLOK_QA_FIXTURES || !process.env.DATABASE_URL?.includes('/billokqa')) {
    throw new Error('Disposable QA PostgreSQL only');
  }
  const personId = randomUUID();
  const personToken = issueGuestPersonToken();
  const shared = issueGuestShareLink();
  const rowId = 'qa-person-roundtrip-' + randomUUID();
  try {
    const original = await db.guestSplit.create({
      data: {
        id: rowId,
        ...shared.stored,
        receiptData: { currency: 'RUB', subtotal: 0, tax: 0, tip: 0, total: 0 },
        items: [],
        assignments: [],
        people: [{ id: personId, name: 'Тестовый гость', personToken }],
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    assert.equal((original.people as { personToken?: string }[])[0]!.personToken, personToken);
    const stored = await db.$queryRawUnsafe<{ people: unknown }[]>(
      'SELECT people FROM "GuestSplit" WHERE id = $1',
      rowId,
    );
    const disk = JSON.stringify(stored[0]?.people);
    assert(!disk.includes(personToken), 'Plain bearer must never be stored in DB');
    assert(disk.includes('v1.'), 'Missing authenticated ciphertext');

    const rotated = issueGuestPersonToken();
    await db.$transaction(async (tx) => {
      const current = await tx.guestSplit.findUniqueOrThrow({ where: { id: rowId } });
      const person = (current.people as { id: string; name: string; personToken: string }[])[0]!;
      assert.equal(person.personToken, personToken);
      await tx.guestSplit.update({
        where: { id: rowId },
        data: { people: [{ ...person, personToken: rotated }] },
      });
    });
    const actual = await db.guestSplit.findUniqueOrThrow({ where: { id: rowId }, select: { people: true } });
    assert.equal((actual.people as { personToken?: string }[])[0]!.personToken, rotated);
    assert.notEqual((actual.people as { personToken?: string }[])[0]!.personToken, personToken);
    const persisted = await db.$queryRawUnsafe<{ people: unknown }[]>(
      'SELECT people FROM "GuestSplit" WHERE id = $1',
      rowId,
    );
    assert(!JSON.stringify(persisted[0]?.people).includes(rotated), 'Rotation bearer persisted as cleartext');
    console.log('GUEST_PERSON_SECRET_PRISMA_ROUNDTRIP=PASS');
  } finally {
    await db.guestSplit.deleteMany({ where: { id: rowId } });
    await db.$disconnect();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'QA failure');
  process.exitCode = 1;
});
