/**
 * Only use with the disposable CI PostgreSQL instance.
 * Emits exactly two GITHUB_ENV-compatible lines for Playwright.
 */
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { assertDisposableQaDatabase } from '../scripts/qa-fixture-database';

async function main() {
  const url = assertDisposableQaDatabase(process.env);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const bob = await db.user.findUniqueOrThrow({ where: { email: 'bob@qa.billok.ru' } });
    const group = await db.group.findFirstOrThrow({
      where: { name: 'Apartment', members: { some: { userId: bob.id } } },
    });
    const receipt = await db.receipt.create({
      data: {
        groupId: group.id,
        uploadedById: bob.id,
        status: 'COMPLETED',
        extractedData: {
          merchantName: 'Тестовый чек',
          subtotal: 9000,
          tax: 0,
          tip: 0,
          total: 9000,
          currency: group.currency,
        },
        items: {
          create: [
            { name: 'Суп', quantity: 3, unitPrice: 2000, totalPrice: 6000, sortOrder: 0 },
            { name: 'Чай', quantity: 1, unitPrice: 3000, totalPrice: 3000, sortOrder: 1 },
          ],
        },
      },
    });
    // The seed group itself is RUB, including its existing members. No extra
    // throwaway group or legacy foreign-currency fixture is needed.
    if (group.currency !== 'RUB') {
      throw new Error('Mobile receipt test fixture must use RUB');
    }
    process.stdout.write('BILLOK_MOBILE_RECEIPT_ID=' + receipt.id + '\n');
    process.stdout.write('BILLOK_MOBILE_GROUP_ID=' + group.id + '\n');
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
