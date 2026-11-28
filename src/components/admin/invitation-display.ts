import { validDate } from './audit-log-format';
import { SYSTEM_INVITE_TTL_MS } from '@/server/lib/system-invite-lifetime';

type InviteDates = {
  createdAt: unknown;
  expiresAt: unknown;
  usedAt: unknown;
  revokedAt: unknown;
  isReserved: boolean;
  isActive: boolean;
};

export function invitationDisplay(invite: InviteDates) {
  const created = validDate(invite.createdAt);
  const storedExpiry = validDate(invite.expiresAt);
  const used = validDate(invite.usedAt);
  const revoked = validDate(invite.revokedAt);
  const capped =
    created && storedExpiry
      ? validDate(new Date(Math.min(storedExpiry.getTime(), created.getTime() + SYSTEM_INVITE_TTL_MS)))
      : null;
  const status = invite.revokedAt
    ? 'revoked'
    : invite.usedAt
      ? 'used'
      : !capped
        ? 'expired'
        : invite.isReserved
          ? 'reserved'
          : invite.isActive
            ? 'active'
            : 'expired';
  return { created, expiry: capped, used, revoked, status } as const;
}
