import { describe, expect, it } from 'vitest';
import {
  GUEST_LINK_SECRET_BYTES,
  GUEST_LINK_SECRET_LENGTH,
  guestLinkSecretSchema,
  hashGuestLinkSecret,
  isGuestLinkSecret,
  newGuestLinkSecret,
} from './guest-link-secret';

describe('Issue #1 3.25.2.1: 256-bit independent guest bearer credentials', () => {
  it('generates exactly 32 CSPRNG bytes encoded as URL-safe unpadded base64url', () => {
    expect(GUEST_LINK_SECRET_BYTES).toBe(32);
    expect(GUEST_LINK_SECRET_LENGTH).toBe(43);
    for (let i = 0; i < 100; i++) {
      const secret = newGuestLinkSecret();
      expect(secret).toHaveLength(43);
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
      expect(Buffer.from(secret, 'base64url').toString('base64url')).toBe(secret);
      expect(guestLinkSecretSchema.parse(secret)).toBe(secret);
    }
  });

  it('gives share and personal links independent tokens that cannot reveal their count', () => {
    const all = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const share = newGuestLinkSecret();
      const person = newGuestLinkSecret();
      expect(share).not.toBe(person);
      expect(all.has(share)).toBe(false);
      expect(all.has(person)).toBe(false);
      all.add(share);
      all.add(person);
    }
    expect(all.size).toBe(200);
  });

  it('rejects prior UUIDv4 and cuid bearers, identifiers, timestamps, invalid lengths and padding', () => {
    for (const input of [
      '',
      '123',
      'cm123456789012345678901234',
      'aaaaaaaa-0000-4000-8000-000000000001',
      '2026-11-13T03:44:00+03:00',
      'a'.repeat(42),
      'a'.repeat(44),
      'a'.repeat(42) + '=',
      'a'.repeat(42) + '/',
      'a'.repeat(42) + '+',
      'a'.repeat(43) + '\n',
      null,
      undefined,
    ]) {
      expect(isGuestLinkSecret(input), String(input)).toBe(false);
      expect(guestLinkSecretSchema.safeParse(input).success).toBe(false);
    }
  });

  it('rejects noncanonical base64url unused bits in the final sextet', () => {
    const original = newGuestLinkSecret();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(original.at(-1)!);
    // For 32 bytes (256 bits), 43 base64url chars: last sextet has
    // 2 non-payload bits, which must both equal zero.
    expect(last % 4).toBe(0);
    const forged = original.slice(0, -1) + alphabet[last + 1]!;
    expect(Buffer.from(forged, 'base64url').equals(Buffer.from(original, 'base64url'))).toBe(true);
    expect(isGuestLinkSecret(forged)).toBe(false);
  });

  it('hashes strong bearers to stable 64-character SHA-256 lookup values, without retaining plaintext', () => {
    const a = newGuestLinkSecret();
    const b = newGuestLinkSecret();
    const h = hashGuestLinkSecret(a);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).toBe(hashGuestLinkSecret(a));
    expect(h).not.toBe(hashGuestLinkSecret(b));
    expect(h).not.toContain(a);
    expect(() => hashGuestLinkSecret('aaaaaaaa-0000-4000-8000-000000000001')).toThrow();
  });
});
