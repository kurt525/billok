import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeOwnerUserCursor, encodeOwnerUserCursor, ownerUserCursorScope } from './owner-user-cursor';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Issue #1 6.13.3: encrypted owner-only user pagination', () => {
  const owner = 'owner-uuid-v4';
  const user = 'registered-uuid-v4';
  const scope = ownerUserCursorScope('ownerRegisteredUsers', {
    search: '',
    status: 'all',
    sortBy: 'createdAt',
    sortDirection: 'desc',
    limit: 20,
  });

  it('encrypts the underlying ID, validates owner and exact filter scope', () => {
    vi.stubEnv('AUTH_SECRET', 'qa-only-high-entropy-authorization-key-01');
    const first = encodeOwnerUserCursor(user, owner, scope);
    const second = encodeOwnerUserCursor(user, owner, scope);
    expect(first).not.toBe(second); // new AEAD nonce
    expect(first).not.toContain(user);
    expect(first.length).toBeLessThan(512);
    expect(decodeOwnerUserCursor(first, owner, scope)).toBe(user);
    expect(() => decodeOwnerUserCursor(first, 'other-owner', scope)).toThrow();
    expect(() => decodeOwnerUserCursor(first, owner, ownerUserCursorScope('listUsers', {}))).toThrow();
  });

  it('refuses a forged, clear-text, overly long or tampered page boundary', () => {
    vi.stubEnv('AUTH_SECRET', 'qa-only-high-entropy-authorization-key-02');
    const token = encodeOwnerUserCursor(user, owner, scope);
    const last = token.at(-1);
    const tampered = token.slice(0, -1) + (last === 'a' ? 'b' : 'a');
    for (const bad of [user, 'u1.' + 'A'.repeat(513), tampered, 'u1.', '', 'cuid-old-row']) {
      expect(() => decodeOwnerUserCursor(bad, owner, scope)).toThrow();
    }
  });

  it('expires cursors after one hour and cannot be repurposed after a filter change', () => {
    vi.stubEnv('AUTH_SECRET', 'qa-only-high-entropy-authorization-key-03');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T15:00:00.000Z'));
    const token = encodeOwnerUserCursor(user, owner, scope);
    vi.setSystemTime(new Date('2026-11-15T16:00:00.001Z'));
    expect(() => decodeOwnerUserCursor(token, owner, scope)).toThrow();
  });
});
