import type { AdminAction } from '@/generated/prisma/enums';
import type adminMessages from '../../../messages/ru/admin.json';

type AuditMessageKey = keyof typeof adminMessages.audit;

type Category =
  'user' | 'group' | 'key' | 'invite' | 'registration' | 'mail' | 'file' | 'message' | 'cleanup' | 'security';
type Presentation = { key: AuditMessageKey; category: Category; caution?: boolean };

export const auditActions = {
  USER_DELETED: { key: 'actionUserDeleted', category: 'user', caution: true },
  USER_SUSPENDED: { key: 'actionUserSuspended', category: 'user', caution: true },
  USER_UNSUSPENDED: { key: 'actionUserUnsuspended', category: 'user' },
  GROUP_DELETED: { key: 'actionGroupDeleted', category: 'group', caution: true },
  IMPERSONATION_STARTED: { key: 'actionImpersonation', category: 'security', caution: true },
  IMPERSONATION_ENDED: { key: 'actionImpersonationEnded', category: 'security' },
  OWNER_BOOTSTRAP_STARTED: { key: 'actionOwnerBootstrapStarted', category: 'registration' },
  OWNER_BOOTSTRAP_EMAIL_SENT: { key: 'actionOwnerBootstrapEmail', category: 'mail' },
  OWNER_BOOTSTRAP_COMPLETED: { key: 'actionOwnerBootstrapCompleted', category: 'registration' },
  OWNER_PASSKEY_RECOVERY_REQUESTED: { key: 'actionOwnerRecoveryRequested', category: 'key' },
  PASSKEY_RECOVERY_COMPLETED: { key: 'actionRecoveryCompleted', category: 'key' },
  OWNER_PASSKEY_REVOKED: { key: 'actionPasskeyRevoked', category: 'key', caution: true },
  OWNER_PASSKEY_ADDED: { key: 'actionPasskeyAdded', category: 'key' },
  OWNER_PASSKEY_RENAMED: { key: 'actionPasskeyRenamed', category: 'key' },
  OWNER_PASSKEY_APPROVAL_VERIFIED: { key: 'actionApprovalVerified', category: 'security' },
  INVITE_CREATED: { key: 'actionInviteCreated', category: 'invite' },
  INVITE_REVOKED: { key: 'actionInviteRevoked', category: 'invite', caution: true },
  ANNOUNCEMENT_SET: { key: 'actionAnnouncement', category: 'message' },
  REGISTRATION_MODE_CHANGED: { key: 'actionRegModeChanged', category: 'registration' },
  EXPORT_CREATED: { key: 'actionExportCreated', category: 'file', caution: true },
  TEST_EMAIL_SENT: { key: 'actionTestEmail', category: 'mail' },
  EXPIRED_SPLITS_CLEANED: { key: 'actionSplitsCleaned', category: 'cleanup' },
  UNUSED_RECEIPTS_CLEANED: { key: 'actionUnusedReceiptsCleaned', category: 'cleanup' },
} satisfies Record<AdminAction, Presentation>;

export const securityActions = {
  'admin.ownerSetUserSuspended': { key: 'securityUserAccess', category: 'user' },
  'admin.suspendUser': { key: 'securitySuspendUser', category: 'user' },
  'admin.unsuspendUser': { key: 'securityUnsuspendUser', category: 'user' },
  'admin.deleteUser': { key: 'securityDeleteUser', category: 'user' },
  'admin.deleteGroup': { key: 'securityDeleteGroup', category: 'group' },
  'admin.setRegistrationMode': { key: 'securityRegistrationMode', category: 'registration' },
  'admin.createSystemInvite': { key: 'securityCreateInvite', category: 'invite' },
  'admin.revokeSystemInvite': { key: 'securityRevokeInvite', category: 'invite' },
  'admin.setAnnouncement': { key: 'securityAnnouncement', category: 'message' },
  'admin.sendTestEmail': { key: 'securityTestEmail', category: 'mail' },
  'admin.cleanupUnusedReceipts': { key: 'securityCleanupReceipts', category: 'cleanup' },
  'admin.cleanupExpiredSplits': { key: 'securityCleanupSplits', category: 'cleanup' },
  'admin.cleanupOrphans': { key: 'securityCleanupOrphans', category: 'cleanup' },
  ADMIN_EXPORT: { key: 'securityExport', category: 'file' },
  IMPERSONATION_STARTED: { key: 'securityImpersonation', category: 'security' },
  OWNER_PASSKEY_ADD_STARTED: { key: 'securityPasskeyAddStart', category: 'key' },
  OWNER_PASSKEY_ADDED: { key: 'securityPasskeyAdd', category: 'key' },
  OWNER_PASSKEY_RENAMED: { key: 'securityPasskeyRename', category: 'key' },
  OWNER_PASSKEY_REVOKED: { key: 'securityPasskeyRevoke', category: 'key' },
  OWNER_APPROVAL_STARTED: { key: 'securityApprovalStart', category: 'security' },
  OWNER_APPROVAL_VERIFIED: { key: 'securityApprovalVerify', category: 'security' },
  OWNER_BOOTSTRAP_STARTED: { key: 'securityBootstrapStart', category: 'registration' },
  OWNER_BOOTSTRAP_EMAIL_SENT: { key: 'securityBootstrapEmail', category: 'mail' },
  OWNER_BOOTSTRAP_REPLAY: { key: 'securityBootstrapReplay', category: 'registration' },
  OWNER_RECOVERY_REQUESTED: { key: 'securityOwnerRecoveryRequest', category: 'key' },
  OWNER_RECOVERY_COMPLETED: { key: 'securityOwnerRecoveryComplete', category: 'key' },
  PASSKEY_RECOVERY_START: { key: 'securityRecoveryStart', category: 'key' },
  PASSKEY_RECOVERY_FINISH: { key: 'securityRecoveryFinish', category: 'key' },
  AUTH_REGISTRATION_PROBE: { key: 'securityRegistrationProbe', category: 'registration' },
  AUTH_REGISTRATION_SUBMITTED: { key: 'securityRegistrationSubmit', category: 'registration' },
  AUTH_EMAIL_CONFIRM_ATTEMPT: { key: 'securityEmailConfirm', category: 'mail' },
  AUTH_REGISTRATION_RESEND_ATTEMPT: { key: 'securityEmailResend', category: 'mail' },
} satisfies Record<string, Presentation>;

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function actionPresentation(action: string, security = false): Presentation {
  return (
    own<Presentation>(security ? securityActions : auditActions, action) ?? {
      key: 'unknownAction',
      category: 'security',
    }
  );
}

type Translate = (key: AuditMessageKey, values?: Record<string, string | number>) => string;

export function createAuditDateFormatter(locale: string, timeZone?: string) {
  const options = timeZone ? { timeZone } : {};
  const date = new Intl.DateTimeFormat(locale, {
    ...options,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const numericDate = new Intl.DateTimeFormat(locale, {
    ...options,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const time = new Intl.DateTimeFormat(locale, {
    ...options,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return {
    date: (value: Date) => date.format(value),
    time: (value: Date) => time.format(value),
    full: (value: Date) => numericDate.format(value) + ', ' + time.format(value),
  };
}
export type AuditDateFormatter = ReturnType<typeof createAuditDateFormatter>;

export function validDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
}

type Dated = { id: string; createdAt: Date | string };
export function groupAuditEntries<T extends Dated>(
  entries: readonly T[],
  formatter: AuditDateFormatter,
  unknownDate: string,
) {
  const groups = new Map<string, T[]>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const date = validDate(entry.createdAt);
    const key = date ? formatter.date(date) : unknownDate;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups].map(([date, items]) => ({ date, items }));
}

export function auditTime(value: Date | string, formatter: AuditDateFormatter) {
  const date = validDate(value);
  return date ? { text: formatter.time(date), iso: date.toISOString() } : null;
}

const modes: Record<string, AuditMessageKey> = {
  open: 'modeOpen',
  closed: 'modeClosed',
  'invite-only': 'modeInviteOnly',
  'local-passkey-only': 'modeLocalPasskey',
};
const methods: Record<string, AuditMessageKey> = {
  'email-verification-no-signin': 'methodEmailOnly',
  'verified-email': 'methodVerifiedEmail',
  'verified-email-plus-webauthn': 'methodEmailAndKey',
  'existing-signed-passkey-approval': 'methodExistingKey',
  'fresh-signed-owner-approval': 'methodOwnerApproval',
};
const approvalActions: Record<string, AuditMessageKey> = {
  ADD: 'securityPasskeyAdd',
  RENAME: 'securityPasskeyRename',
  REVOKE: 'securityPasskeyRevoke',
  USER_SUSPEND: 'securitySuspendUser',
  USER_UNSUSPEND: 'securityUnsuspendUser',
  USER_DELETE: 'securityDeleteUser',
  SYSTEM_INVITE_CREATE: 'securityCreateInvite',
  SYSTEM_INVITE_REVOKE: 'securityRevokeInvite',
  REGISTRATION_MODE_UPDATE: 'securityRegistrationMode',
  OWNER_SETTING_UPDATE: 'securityOwnerSetting',
  IMPERSONATE: 'securityImpersonation',
  ADMIN_EXPORT: 'securityExport',
};

/** Only event-specific known fields; never stringify arbitrary metadata,
 * bearer codes, approval proofs, identifiers, or raw provider errors. */
export function auditDetails(action: string, metadata: unknown, t: Translate, dates: AuditDateFormatter): string[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const m = metadata as Record<string, unknown>;
  const parts: string[] = [];
  function text(field: string, key: AuditMessageKey, max: number) {
    const value = m[field];
    if (typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)) {
      parts.push(t(key, { value }));
    }
  }
  function email(field: string, key: AuditMessageKey) {
    const value = m[field];
    if (typeof value === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value)) text(field, key, 320);
  }
  function count(field: string, key: AuditMessageKey) {
    const value = m[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) parts.push(t(key, { count: value }));
  }
  function known(field: string, map: Record<string, AuditMessageKey>, prefix?: AuditMessageKey) {
    const value = m[field];
    const label = typeof value === 'string' ? own(map, value) : undefined;
    if (label) parts.push(prefix ? t(prefix, { value: t(label) }) : t(label));
  }
  function timestamp(field: string, key: AuditMessageKey) {
    const value = validDate(m[field]);
    if (value) parts.push(t(key, { value: dates.full(value) }));
  }
  switch (action) {
    case 'INVITE_CREATED':
      text('label', 'detailLabel', 100);
      timestamp('expiresAt', 'detailInviteExpiry');
      break;
    case 'INVITE_REVOKED':
      timestamp('revokedAt', 'detailInviteRevoked');
      break;
    case 'USER_DELETED':
    case 'USER_SUSPENDED':
    case 'USER_UNSUSPENDED':
      email('email', 'detailEmail');
      break;
    case 'GROUP_DELETED':
      text('name', 'detailName', 500);
      break;
    case 'IMPERSONATION_STARTED':
    case 'IMPERSONATION_ENDED':
      text('targetName', 'detailName', 500);
      email('targetEmail', 'detailEmail');
      break;
    case 'REGISTRATION_MODE_CHANGED':
    case 'OWNER_BOOTSTRAP_STARTED':
      known('mode', modes);
      break;
    case 'ANNOUNCEMENT_SET':
      if (m.message === null || m.message === '') parts.push(t('detailAnnouncementCleared'));
      else if (typeof m.message === 'string') {
        // Preserve the existing short preview rather than expose the full message.
        const preview = m.message.slice(0, 50).replace(/\s+/gu, ' ').trim();
        if (preview) parts.push(t('detailAnnouncement', { value: preview + (m.message.length > 50 ? '…' : '') }));
      }
      break;
    case 'TEST_EMAIL_SENT':
      email('to', 'detailRecipient');
      count('durationMs', 'detailDuration');
      if (m.success === false) parts.push(t('detailFailed'));
      break;
    case 'EXPIRED_SPLITS_CLEANED':
    case 'UNUSED_RECEIPTS_CLEANED':
      count('deletedCount', 'filesDeleted');
      break;
    case 'EXPORT_CREATED':
      count('tableCount', 'detailTableCount');
      break;
    case 'OWNER_BOOTSTRAP_EMAIL_SENT':
    case 'OWNER_PASSKEY_RECOVERY_REQUESTED':
    case 'PASSKEY_RECOVERY_COMPLETED':
    case 'OWNER_PASSKEY_ADDED':
    case 'OWNER_PASSKEY_REVOKED':
      known('method', methods, 'detailMethod');
      count('activePasskeys', 'detailActiveKeys');
      count('activeRemaining', 'detailActiveKeys');
      count('revokedPasskeys', 'detailRevokedKeys');
      if (m.accountType === 'owner') parts.push(t('detailOwnerAccount'));
      if (m.accountType === 'regular') parts.push(t('detailRegularAccount'));
      if (m.previousSessionsRevoked === true) parts.push(t('detailSessionsRevoked'));
      if (m.sessionIssued === false) parts.push(t('detailNoSession'));
      break;
    case 'OWNER_BOOTSTRAP_COMPLETED':
      count('activePasskeys', 'detailActiveKeys');
      count('optionalMaxPasskeys', 'detailMaxKeys');
      break;
    case 'OWNER_PASSKEY_APPROVAL_VERIFIED':
      known('action', approvalActions, 'detailOperation');
      count('expiresInSeconds', 'detailApprovalSeconds');
      break;
    default:
      break;
  }
  return parts;
}
