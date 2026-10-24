/**
 * Only use with the disposable CI PostgreSQL instance.
 * Emits exactly two GITHUB_ENV-compatible lines for Playwright.
 */
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

async function main() {
  if (process.env.BILLOK_QA_FIXTURES !== '1') {
    throw new Error('Receipt fixture creation requires BILLOK_QA_FIXTURES=1');
  }
  const url = process.env.DATABASE_URL ?? '';
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/billokqa') {
    throw new Error('Receipt fixture requires a local disposable billokqa database');
  }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const bob = await db.user.findUniqueOrThrow({ where: { email: 'bob@example.com' } });
    const group = await db.group.findFirstOrThrow({
      where: { name: 'Apartment', members: { some: { userId: bob.id } } },
    });
    const receipt = await db.receipt.create({
      data: {
        groupId: group.id,
        uploadedById: bob.id,
        imagePath: '',
        originalName: 'mobile-qa-fixture.png',
        mimeType: 'image/png',
        fileSize: 0,
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
