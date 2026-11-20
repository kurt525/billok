import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { hashGuestLinkSecret } from './guest-link-secret';
import { issueGuestShareLink, revealGuestShareLink, sealGuestShareToken, shareLookupHash } from './guest-share-link';

describe('Issue #1 3.25.2.2: shared bearer is never stored in plaintext', () => {
  beforeEach(() => vi.stubEnv('AUTH_SECRET', 'one-disposable-QA-deployment-secret-with-at-least-32-characters'));
  afterEach(() => vi.unstubAllEnvs());

  it('stores SHA-256 digest and authenticated encrypted copy, never raw bearer', () => {
    const { token, stored } = issueGuestShareLink();
    expect(token).toHaveLength(43);
    expect(stored.shareToken).toBe(hashGuestLinkSecret(token));
    expect(stored.shareToken).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.shareToken).not.toBe(token);
    expect(stored.shareTokenSealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(stored.shareTokenSealed).not.toContain(token);
    expect(revealGuestShareLink(stored)).toBe(token);
    expect(shareLookupHash(token)).toBe(stored.shareToken);
  });

  it('uses random nonce: encrypting the same token twice yields different sealed values', () => {
    const { token } = issueGuestShareLink();
    const a = sealGuestShareToken(token);
    const b = sealGuestShareToken(token);
    expect(a).not.toBe(b);
    expect(revealGuestShareLink({ shareToken: hashGuestLinkSecret(token), shareTokenSealed: a })).toBe(token);
    expect(revealGuestShareLink({ shareToken: hashGuestLinkSecret(token), shareTokenSealed: b })).toBe(token);
  });

  it('rejects a tampered sealed token and changed database digest', () => {
    const { token, stored } = issueGuestShareLink();
    const sealed = stored.shareTokenSealed!;
    const tail = sealed.slice(-1);
    const changed = tail === 'A' ? 'B' : 'A';
    expect(() => revealGuestShareLink({ ...stored, shareTokenSealed: sealed.slice(0, -1) + changed })).toThrow();
    expect(() => revealGuestShareLink({ ...stored, shareToken: '0'.repeat(64) })).toThrow();
    expect(() => revealGuestShareLink({ ...stored, shareTokenSealed: null })).toThrow();
    expect(() => revealGuestShareLink({ ...stored, shareTokenSealed: token })).toThrow();
  });

  it('fails closed when the deployment key is missing or changed', () => {
    const { stored } = issueGuestShareLink();
    vi.stubEnv('AUTH_SECRET', '');
    vi.stubEnv('NEXTAUTH_SECRET', '');
    expect(() => issueGuestShareLink()).toThrow('ключ');
    expect(() => revealGuestShareLink(stored)).toThrow('недоступна');
    vi.stubEnv('AUTH_SECRET', 'a-different-disposable-secret-key-value-that-is-long-enough');
    expect(() => revealGuestShareLink(stored)).toThrow('недоступна');
  });

  it('invalid and old short tokens cannot resolve a database record', () => {
    const { token } = issueGuestShareLink();
    for (const invalid of ['', 'abc', 'cuid12345', 'aaaaaaaa-0000-4000-8000-000000000001']) {
      expect(shareLookupHash(invalid)).toBe('invalid-guest-share-token');
      expect(shareLookupHash(invalid)).not.toBe(shareLookupHash(token));
    }
  });

  it('routes share lookups through digest and never returns a stored hash as a guest bearer', () => {
    const router = readFileSync('src/server/trpc/routers/guest.ts', 'utf8');
    const sse = readFileSync('src/app/api/guest/[token]/events/route.ts', 'utf8');
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    expect(router).not.toContain('where: { shareToken: input.token }');
    expect(router).not.toContain('shareToken: session.shareToken,');
    expect(router).not.toContain('shareToken: split.shareToken,');
    expect(router).toContain('shareToken: revealGuestShareLink(s),');
    expect(router).toContain('shareToken: shareLookupHash(input.token)');
    expect(router).toContain('...share.stored');
    expect(sse).toContain('shareLookupHash(token)');
    expect(schema).not.toContain('shareToken  String   @unique @default(cuid())');
    expect(schema).toContain('shareTokenSealed String?');
  });
});
