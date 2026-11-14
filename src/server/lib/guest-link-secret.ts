import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Issue #1 3.25.2.1: a bearer credential is NEVER a personId, Prisma cuid,
 * date, counter or another credential. Draw 256 independent bits from the OS
 * cryptographic random generator for each share link and personal link.
 *
 * base64url encodes 32 bytes into 43 URL-safe characters (no padding).
 */
export const GUEST_LINK_SECRET_BYTES = 32;
export const GUEST_LINK_SECRET_LENGTH = 43;
const base64url32 = /^[A-Za-z0-9_-]{43}$/;

export function isGuestLinkSecret(input: unknown): input is string {
  if (typeof input !== 'string' || !base64url32.test(input)) return false;
  const bytes = Buffer.from(input, 'base64url');
  // Comparing the canonical round-trip also rejects forged / noncanonical
  // padding bits in the last character.
  return bytes.length === GUEST_LINK_SECRET_BYTES && bytes.toString('base64url') === input;
}

export const guestLinkSecretSchema = z.string().refine(isGuestLinkSecret, 'Недопустимый формат секретной ссылки');

/** One fresh independently random 256-bit bearer secret for each invocation. */
export function newGuestLinkSecret(): string {
  const token = randomBytes(GUEST_LINK_SECRET_BYTES).toString('base64url');
  if (!isGuestLinkSecret(token)) throw new Error('Не удалось создать секретную ссылку');
  return token;
}

/**
 * Stable fingerprint suitable for indexed, one-way DB lookup; the raw bearer
 * credential must never be logged or used as a long-lived database key.
 * No secret suffix, date, user ID or global sequence leaks into this digest.
 */
export function hashGuestLinkSecret(token: string): string {
  if (!isGuestLinkSecret(token)) throw new Error('Недопустимый формат секретной ссылки');
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
