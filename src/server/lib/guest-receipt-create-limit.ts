import { checkRateLimit, parsePositiveInt } from './rate-limit';

/**
 * Issue 3.23: signed-in account's short anti-spam burst, shared by
 * both receipt creation endpoints. No hourly or lifetime receipt quota.
 * The stable, authenticated account ID is independent of others' IPs
 * on restaurant Wi-Fi or shared mobile carrier NAT.
 *
 * Default: 60 rapid receipt creations in 60 seconds; after that, the
 * window expires. The existing GUEST_RATE_LIMIT_MAX override controls
 * this per-account, per-minute burst (including disposable QA tests).
 */
export const RECEIPT_CREATE_BURST_WINDOW_MS = 60_000;
export const DEFAULT_RECEIPT_CREATE_BURST = 60;

export function checkGuestReceiptCreationLimit(userId: string): boolean {
  const max = parsePositiveInt(process.env.GUEST_RATE_LIMIT_MAX, DEFAULT_RECEIPT_CREATE_BURST);
  return checkRateLimit('guest-create-account:' + userId, max, RECEIPT_CREATE_BURST_WINDOW_MS).allowed;
}
