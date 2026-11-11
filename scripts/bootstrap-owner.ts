/**
 * LOCAL terminal command only. This script MUST NOT be imported into a web
 * handler or run in CI against a persistent database.
 *
 * Example (environment configured on the server; no token in arguments):
 * BILLOK_OWNER_BOOTSTRAP_ACK=CREATE_INITIAL_OWNER npx tsx scripts/bootstrap-owner.ts --create
 *
 * After a temporary SMTP failure, use --resend. Maximum three attempts.
 * The owner must have a .ru/.su ADMIN_EMAIL and confirm their actual inbox;
 * no password, seeded admin, magic link sign-in, or public bootstrap route.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  createInitialOwner,
  readOwnerBootstrapConfiguration,
  sendOwnerBootstrapConfirmation,
} from '../src/server/lib/owner-bootstrap';

async function main() {
  const mode = process.argv.slice(2);
  if (mode.length !== 1 || (mode[0] !== '--create' && mode[0] !== '--resend')) {
    throw new Error('Usage: scripts/bootstrap-owner.ts --create | --resend');
  }
  // Refuse a non-interactive invocation. There is deliberately no HTTP,
  // environment-only auto-setup, or default owner identity.
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error('Bootstrap requires an operator at the local server terminal');
  }
  readOwnerBootstrapConfiguration(process.env);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    if (mode[0] === '--create') {
      await createInitialOwner({ db, env: process.env });
    }
    await sendOwnerBootstrapConfirmation({ db, env: process.env });
    process.stdout.write(
      'Письмо для настройки владельца отправлено. Пароли не создавались.\n' +
        'Завершите регистрацию двух разных ключей Passkey на billok.ru.\n',
    );
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  // Do not print database credentials, SMTP auth or verification tokens.
  process.stderr.write(
    error instanceof Error && /Bootstrap requires|Usage:|DATABASE_URL is required/.test(error.message)
      ? error.message + '\n'
      : 'Первоначальная настройка владельца отклонена. Проверьте безопасную конфигурацию и журнал.\n',
  );
  process.exitCode = 1;
});
