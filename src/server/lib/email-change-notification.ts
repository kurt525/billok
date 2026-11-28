import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@/generated/prisma/client';
import { readRegistrationEmailConfig } from './auth-config';
import { sendBillokTransactionalEmail } from './transactional-email';
import { logger } from './logger';
import { readBillokWebAuthnRelyingParty } from './webauthn-relying-party';
import { normalizeAllowedRegistrationEmail } from './registration-email-domain';

type Env = Record<string, string | undefined>;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 5;

function recipientKey(env: Env) {
  const secret = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error('Email change encryption unavailable');
  return createHmac('sha256', secret).update('billok:email-change-notification:v1').digest();
}

export function encryptEmailChangeRecipient(email: string, operationId: string, env: Env = process.env) {
  if (!normalizeAllowedRegistrationEmail(email)) throw new Error('Invalid notification recipient');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', recipientKey(env), nonce);
  cipher.setAAD(Buffer.from(operationId));
  const encrypted = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptEmailChangeRecipient(value: string, operationId: string, env: Env = process.env) {
  const parts = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16 || parts[2]!.length > 254)
    throw new Error('Invalid notification');
  const cipher = createDecipheriv('aes-256-gcm', recipientKey(env), parts[0]!);
  cipher.setAAD(Buffer.from(operationId));
  cipher.setAuthTag(parts[1]!);
  const email = Buffer.concat([cipher.update(parts[2]!), cipher.final()]).toString('utf8');
  if (!normalizeAllowedRegistrationEmail(email)) throw new Error('Invalid recipient');
  return email;
}

export function emailChangeNotificationExpiry(now: Date) {
  return new Date(now.getTime() + RETENTION_MS);
}

export async function sendEmailChangeConfirmation(email: string, token: string, env: Env = process.env) {
  const mail = readRegistrationEmailConfig(env);
  if (mail.siteOrigin !== readBillokWebAuthnRelyingParty(env).origin) throw new Error('Untrusted email change origin');
  // A fragment never travels to HTTP, proxy access logs or Referer.
  const link = new URL('/settings', mail.siteOrigin);
  link.hash = 'email-change=' + token;
  await sendBillokTransactionalEmail({
    from: mail.from,
    to: email,
    server: mail.server,
    message: {
      subject: 'BillOK — подтверждение нового адреса электронной почты',
      text: [
        'Для изменения электронной почты откройте ссылку в том же браузере, где подтвердили операцию ключом доступа.',
        link.toString(),
        'Ссылка действует 30 минут. Подтвердите изменение в настройках. Если вы не запрашивали смену, проигнорируйте письмо.',
      ].join('\n\n'),
    },
    errorMessage: 'Email change confirmation delivery failed',
    timeouts: { connectionTimeout: 4_000, greetingTimeout: 4_000, socketTimeout: 6_000 },
  });
}

// Atomic lease prevents simultaneous workers from sending the same notice.
// SMTP cannot guarantee exactly-once delivery after an ambiguous disconnect;
// retry may send the notice again, but can never repeat the account mutation.
export async function processEmailChangeNotifications(db: PrismaClient, env: Env = process.env, now = new Date()) {
  const expiredRequests = await db.emailChangeRequest.findMany({
    where: { expiresAt: { lte: now } },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: 100,
  });
  if (expiredRequests.length)
    await db.emailChangeRequest.deleteMany({
      where: { id: { in: expiredRequests.map((row) => row.id) }, expiresAt: { lte: now } },
    });
  const expiredNotices = await db.emailChangeNotification.findMany({
    where: { expiresAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: 100,
  });
  if (expiredNotices.length)
    await db.emailChangeNotification.deleteMany({
      where: {
        id: { in: expiredNotices.map((row) => row.id) },
        expiresAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
    });
  const ready = await db.emailChangeNotification.findMany({
    where: {
      expiresAt: { gt: now },
      nextAttemptAt: { lte: now },
      attempts: { lt: MAX_ATTEMPTS },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    take: 10,
  });
  for (const entry of ready) {
    const leaseId = randomUUID();
    const claimedAt = new Date(Math.max(now.getTime(), Date.now()));
    const lease = await db.emailChangeNotification.updateMany({
      where: {
        id: entry.id,
        expiresAt: { gt: claimedAt },
        nextAttemptAt: { lte: claimedAt },
        attempts: entry.attempts,
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: claimedAt } }],
      },
      data: { leaseId, leaseUntil: new Date(claimedAt.getTime() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (lease.count !== 1) continue;
    try {
      const mail = readRegistrationEmailConfig(env);
      await sendBillokTransactionalEmail({
        from: mail.from,
        to: decryptEmailChangeRecipient(entry.encryptedRecipient, entry.id, env),
        server: mail.server,
        message: {
          subject: 'BillOK — изменена электронная почта',
          text: 'Электронная почта вашей учётной записи BillOK изменена после подтверждения ключом доступа и нового адреса. Если вы не совершали это действие, обратитесь к владельцу BillOK. В письме нет ссылок для входа или отмены операции.',
        },
        errorMessage: 'Email change notice delivery failed',
        timeouts: { connectionTimeout: 4_000, greetingTimeout: 4_000, socketTimeout: 6_000 },
      });
      await db.emailChangeNotification.deleteMany({ where: { id: entry.id, leaseId } });
    } catch {
      logger.warn('auth.email_change_notice_failed', { attempt: entry.attempts + 1 });
      await db.emailChangeNotification.updateMany({
        where: { id: entry.id, leaseId },
        data: {
          leaseId: null,
          leaseUntil: null,
          nextAttemptAt: new Date(Date.now() + Math.min(24 * 60, 5 * 2 ** entry.attempts) * 60_000),
        },
      });
    }
  }
}

let running = false;
let timer: ReturnType<typeof setInterval> | undefined;
export function startEmailChangeMaintenance(db: PrismaClient) {
  if (timer) return;
  async function tick() {
    if (running) return;
    running = true;
    try {
      await processEmailChangeNotifications(db);
    } catch {
      logger.warn('auth.email_change_maintenance_failed');
    } finally {
      running = false;
    }
  }
  timer = setInterval(() => void tick(), 60_000);
  timer.unref();
}
