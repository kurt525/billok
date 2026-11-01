import { createHash, randomBytes } from 'node:crypto';
import { prepareRegistrationVerificationLink } from './registration-verification-link';

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
export function preparePasswordResetLink(siteOrigin: string, now: Date = new Date()) {
  const checked = prepareRegistrationVerificationLink(siteOrigin, now);
  const token = randomBytes(32).toString('base64url');
  const url = new URL(checked.url);
  url.pathname = '/reset-password';
  url.searchParams.set('token', token);
  return {
    url: url.toString(),
    tokenHash: hashPasswordResetToken(token),
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
  };
}
