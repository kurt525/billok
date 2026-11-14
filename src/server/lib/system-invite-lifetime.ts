/** Issue #1 6.2: no BillOK invitation remains valid beyond seven days.
 * Apply BOTH checks to legacy codes, too: older ShareTab records may have
 * expiresAt=null or an arbitrarily distant expiry. They must not bypass policy.
 * A code is single-use; reservation and redemption additionally check
 * usedAt/usedById/revokedAt in the same conditional database write.
 */
export const SYSTEM_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function activeSystemInviteWindow(now: Date) {
  return {
    createdAt: { gt: new Date(now.getTime() - SYSTEM_INVITE_TTL_MS) },
    expiresAt: { gt: now },
  };
}
