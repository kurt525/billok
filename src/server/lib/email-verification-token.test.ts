import { describe, expect, it } from 'vitest';
import {
  createEmailVerificationToken,
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  hasEmailVerificationTokenExpired,
  hashEmailVerificationToken,
} from './email-verification-token';

describe('registration email confirmation tokens', () => {
  it('creates distinct 256-bit URL-safe secrets and stores only SHA-256 digests', () => {
    const first = createEmailVerificationToken(new Date('2026-10-31T10:00:00.000Z'));
    const second = createEmailVerificationToken(new Date('2026-10-31T10:00:00.000Z'));

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tokenHash).toBe(hashEmailVerificationToken(first.token));
    expect(first.token).not.toBe(first.tokenHash);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });

  it('expires exactly 30 minutes after issuance', () => {
    const issued = new Date('2026-10-31T10:00:00.000Z');
    const token = createEmailVerificationToken(issued);
    expect(EMAIL_VERIFICATION_TOKEN_TTL_MS).toBe(1_800_000);
    expect(token.expiresAt.toISOString()).toBe('2026-10-31T10:30:00.000Z');

    expect(hasEmailVerificationTokenExpired(token.expiresAt, new Date('2026-10-31T10:29:59.999Z'))).toBe(false);
    expect(hasEmailVerificationTokenExpired(token.expiresAt, new Date('2026-10-31T10:30:00.000Z'))).toBe(true);
    expect(hasEmailVerificationTokenExpired(token.expiresAt, new Date('2026-10-31T10:31:00.000Z'))).toBe(true);
  });
});
