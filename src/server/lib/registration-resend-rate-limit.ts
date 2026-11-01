import { createHash } from 'node:crypto';
import { getClientIp } from './client-ip';
import { checkRateLimit } from './rate-limit';

const HOUR_MS = 60 * 60 * 1000;

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

  const normalizedEmail = email.trim().toLowerCase();
  const emailHash = createHash('sha256').update(normalizedEmail, 'utf8').digest('hex');
  return checkRateLimit('auth:registration-resend:email:' + emailHash, 3, HOUR_MS).allowed;
}
