import { checkRateLimit } from './rate-limit';

/**
 * Issue #1 6.12.4: operational WebAuthn confirmations are NOT subject to
 * hourly/daily quotas. A verified owner can authorize arbitrarily many
 * sequential actions; only a machine-speed burst is rejected temporarily.
 *
 * Account-scoped instead of IP-scoped: shared NAT/VPN users cannot exhaust
 * the owner's WebAuthn allowance. No throttle applies to other owners.
 * This is an abuse safeguard, not a business-action quota.
 */
export const OWNER_WEBAUTHN_BURST_MAX = 8;
export const OWNER_WEBAUTHN_BURST_WINDOW_MS = 2_000;

export type OwnerWebAuthnRoute = 'approval-start' | 'approval-finish' | 'add-start' | 'add-finish';

export function allowOwnerWebAuthnRequest(ownerId: string, route: OwnerWebAuthnRoute): boolean {
  if (!ownerId) return false;
  return checkRateLimit(
    'owner-webauthn-burst:' + route + ':' + ownerId,
    OWNER_WEBAUTHN_BURST_MAX,
    OWNER_WEBAUTHN_BURST_WINDOW_MS,
  ).allowed;
}
