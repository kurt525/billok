import { createHash } from 'node:crypto';
import type { PrismaClient, SecurityEventOutcome } from '@/generated/prisma/client';
import { readRegistrationEmailConfig } from './auth-config';
import { sendBillokTransactionalEmail } from './transactional-email';
import { logger } from './logger';
import { readBillokWebAuthnRelyingParty } from './webauthn-relying-party';

const SAFE_ACTION = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CRITICAL = new Set([
  'admin.deleteUser',
  'admin.suspendUser',
  'admin.unsuspendUser',
  'admin.ownerSetUserSuspended',
  'admin.createSystemInvite',
  'admin.revokeSystemInvite',
  'admin.setRegistrationMode',
  'admin.setAnnouncement',
  'admin.cleanupOrphans',
  'IMPERSONATION_STARTED',
  'ADMIN_EXPORT',
  'OWNER_APPROVAL_VERIFIED',
  'OWNER_PASSKEY_ADDED',
  'OWNER_PASSKEY_RENAMED',
  'OWNER_PASSKEY_REVOKED',
  'OWNER_RECOVERY_REQUESTED',
  'OWNER_RECOVERY_COMPLETED',
  'OWNER_BOOTSTRAP_REPLAY',
]);

/** Do not persist even a plausible targetId verbatim: an attacker may place
 * a bearer token into the userId/inviteId field of a rejected request. */
export function securityTargetFingerprint(value: unknown): string | null {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) return null;
  return createHash('sha256')
    .update('billok-security-target:' + value)
    .digest('hex');
}

/** Explicit allowlist only. Never serialize the entire untrusted request. */
export function securityTargetFromInput(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of ['userId', 'inviteId', 'targetId', 'groupId', 'placeholderUserId']) {
    if (key in record) return securityTargetFingerprint(record[key]);
  }
  return null;
}

export function russianSecurityAlert(input: {
  action: string;
  outcome: SecurityEventOutcome;
  actorId: string | null;
  targetFingerprint: string | null;
  when: Date;
}) {
  const lines = [
    'BillOK — событие безопасности',
    'Операция: ' + input.action,
    'Результат: ' + (input.outcome === 'DENIED' ? 'Отклонено' : 'Выполнено'),
    'Учётная запись: ' + (input.actorId ?? 'Не установлена'),
    'Объект (контрольный отпечаток): ' + (input.targetFingerprint?.slice(0, 16) ?? 'Не указан'),
    'Время UTC: ' + input.when.toISOString(),
    'Если действие вам неизвестно, проверьте безопасность своей почты и Passkey.',
    'В этом письме нет ссылок входа, токенов или кодов доступа.',
  ];
  return {
    subject:
      input.outcome === 'DENIED'
        ? 'BillOK — подозрительная попытка административной операции'
        : 'BillOK — выполнено критичное административное действие',
    text: lines.join('\n'),
  };
}

type SecurityAuditStore = Pick<PrismaClient, 'securityEvent' | 'securityAlertDelivery' | 'ownerBootstrap'>;

export async function recordOwnerSecurityEvent(input: {
  db: SecurityAuditStore;
  action: string;
  outcome: SecurityEventOutcome;
  actorId?: string | null;
  targetFingerprint?: string | null;
  env?: Record<string, string | undefined>;
  now?: Date | undefined;
}): Promise<void> {
  // All details are selected server-side. Never persist raw URL, cookie,
  // WebAuthn response, approval token or attacker-controlled JSON.
  if (!SAFE_ACTION.test(input.action) || !['ALLOWED', 'DENIED'].includes(input.outcome)) return;
  const actorId = typeof input.actorId === 'string' && SAFE_ID.test(input.actorId) ? input.actorId : null;
  const targetFingerprint =
    typeof input.targetFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(input.targetFingerprint)
      ? input.targetFingerprint
      : null;
  const when = input.now ?? new Date();
  // Prisma delegate is always present with the generated client. Some
  // older test-only fixtures expose just the models needed by their tests.
  if (typeof input.db.securityEvent?.create !== 'function') return;
  try {
    await input.db.securityEvent.create({
      data: { action: input.action, outcome: input.outcome, actorId, targetFingerprint, createdAt: when },
    });
  } catch (error) {
    logger.error('security.audit_write_failed', {
      action: input.action,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return;
  }

  // Never throttle/reject ANY owner's operation; throttle only repeated
  // notification emails about denied requests across multiple instances.
  if (input.outcome !== 'DENIED' && !CRITICAL.has(input.action)) return;
  const bucket =
    input.outcome === 'DENIED'
      ? 'denied:' +
        createHash('sha256').update(input.action).digest('hex').slice(0, 24) +
        ':' +
        Math.floor(when.getTime() / 900_000)
      : null;
  if (bucket) {
    try {
      await input.db.securityAlertDelivery.create({ data: { bucket } });
    } catch {
      // Duplicate alert bucket or unavailable DB: event was still recorded.
      return;
    }
  }
  try {
    const owner = await input.db.ownerBootstrap.findUnique({
      where: { id: 1 },
      include: { user: { select: { email: true, emailVerified: true, suspendedAt: true, isPlaceholder: true } } },
    });
    if (!owner?.completedAt || !owner.user.emailVerified || owner.user.suspendedAt || owner.user.isPlaceholder) return;
    const env = input.env ?? process.env;
    const mail = readRegistrationEmailConfig(env);
    if (mail.siteOrigin !== readBillokWebAuthnRelyingParty(env).origin) return;
    await sendBillokTransactionalEmail({
      from: mail.from,
      to: owner.user.email,
      server: mail.server,
      message: russianSecurityAlert({
        action: input.action,
        outcome: input.outcome,
        actorId,
        targetFingerprint,
        when,
      }),
      errorMessage: 'Delivery rejected',
      timeouts: { connectionTimeout: 4_000, greetingTimeout: 4_000, socketTimeout: 6_000 },
    });
  } catch (error) {
    logger.warn('security.owner_alert_failed', {
      action: input.action,
      error: error instanceof Error ? error.name : 'unknown',
    });
    // Notification failure cannot approve a denied action or undo a committed
    // legitimate operation. The event is already safely stored in the DB.
  }
}
