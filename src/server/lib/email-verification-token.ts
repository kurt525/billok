import { createHash, randomBytes } from 'node:crypto';

// Registration confirmation is separate from the Auth.js magic-link token.
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Only the SHA-256 digest belongs in the database; the raw token goes in one email link. */
export function hashEmailVerificationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Generate an unguessable, URL-safe one-time token and its 30-minute expiration. */
export function createEmailVerificationToken(now: Date = new Date()) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashEmailVerificationToken(token),
    expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
  };
}

export function hasEmailVerificationTokenExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
