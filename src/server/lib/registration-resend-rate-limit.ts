import { createHash } from 'node:crypto';
import { getClientIp } from './client-ip';
import { checkRateLimit } from './rate-limit';

const HOUR_MS = 60 * 60 * 1000;
const resendInFlight = new Set<string>();

function normalizedEmailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

/**
 * Suppress overlapping sends for the same email in one server process.
 * This is defense in depth: it does not replace the rate limits or database
 * ownership checks, and deployment replicas need a shared lock.
 * The set holds hashes, never raw email addresses.
 */
export async function runExclusiveRegistrationVerificationResend(
  email: string,
  work: () => Promise<void>,
): Promise<void> {
  const key = normalizedEmailHash(email);
  if (resendInFlight.has(key)) return;
  resendInFlight.add(key);
  try {
    await work();
  } finally {
    resendInFlight.delete(key);
  }
}

/**
 * Bound resend requests BEFORE looking up an account or sending a message.
 * Global quota also bounds arbitrary email/IP keys (including spoofed proxy
 * headers); the email digest avoids keeping raw addresses in limiter keys.
 *
 * This is an internal guard, not a public resend mutation. A caller must
 * return the same response for unknown, confirmed and ineligible accounts.
 */
export function allowRegistrationVerificationResend(headers: Headers, email: string): boolean {
  if (!checkRateLimit('auth:registration-resend:global', 600, HOUR_MS).allowed) return false;

  const ip = getClientIp(headers);
  if (!checkRateLimit('auth:registration-resend:ip:' + ip, 5, HOUR_MS).allowed) return false;

  const emailHash = normalizedEmailHash(email);
  return checkRateLimit('auth:registration-resend:email:' + emailHash, 3, HOUR_MS).allowed;
}
