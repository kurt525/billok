import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { revealGuestSplitResult, sealGuestPeopleTokens } from './lib/guest-person-secret';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });
  // Every real GuestSplit query, including interactive transactions, must seal
  // personal credentials before writes and unseal only inside server memory.
  return prisma.$extends({
    name: 'guest-person-secrets-at-rest',
    query: {
      guestSplit: {
        async $allOperations({ args, operation, query }) {
          if (operation === 'create' || operation === 'update' || operation === 'upsert') {
            const input = args as {
              data?: { people?: unknown };
              create?: { people?: unknown };
              update?: { people?: unknown };
            };
            for (const data of [input.data, input.create, input.update]) {
              if (data && Object.prototype.hasOwnProperty.call(data, 'people')) {
                data.people = sealGuestPeopleTokens(data.people);
              }
            }
          }
          return revealGuestSplitResult(await query(args));
        },
      },
    },
  }) as unknown as PrismaClient;
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
