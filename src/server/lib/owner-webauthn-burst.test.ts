import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowOwnerWebAuthnRequest,
  OWNER_WEBAUTHN_BURST_MAX,
  OWNER_WEBAUTHN_BURST_WINDOW_MS,
} from './owner-webauthn-burst';

afterEach(() => vi.restoreAllMocks());

describe('Issue 6.12.4: legitimate owner WebAuthn actions have no hourly/daily quota', () => {
  it('permits arbitrarily many sequential actions throughout a workday', () => {
    const ownerId = randomUUID();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    expect(OWNER_WEBAUTHN_BURST_MAX).toBe(8);
    expect(OWNER_WEBAUTHN_BURST_WINDOW_MS).toBe(2_000);
    // 500 verified actions, no cap per hour/day.
    for (let n = 0; n < 500; n++) {
      now.mockReturnValue(1_000_000 + n * 5_000);
      expect(allowOwnerWebAuthnRequest(ownerId, 'approval-start')).toBe(true);
      expect(allowOwnerWebAuthnRequest(ownerId, 'approval-finish')).toBe(true);
    }
  });

  it('rejects only an 9th instant burst, then recovers after 2 seconds', () => {
    const ownerId = randomUUID();
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
    for (let n = 0; n < 8; n++) {
      expect(allowOwnerWebAuthnRequest(ownerId, 'approval-start')).toBe(true);
    }
    expect(allowOwnerWebAuthnRequest(ownerId, 'approval-start')).toBe(false);
    now.mockReturnValue(2_002_001);
    expect(allowOwnerWebAuthnRequest(ownerId, 'approval-start')).toBe(true);
  });

  it('does not share an IP quota between authenticated owners or distinct ceremonies', () => {
    const first = randomUUID(),
      second = randomUUID();
    vi.spyOn(Date, 'now').mockReturnValue(3_000_000);
    for (let n = 0; n < 8; n++) {
      expect(allowOwnerWebAuthnRequest(first, 'approval-start')).toBe(true);
    }
    expect(allowOwnerWebAuthnRequest(first, 'approval-start')).toBe(false);
    expect(allowOwnerWebAuthnRequest(second, 'approval-start')).toBe(true);
    expect(allowOwnerWebAuthnRequest(first, 'approval-finish')).toBe(true);
    expect(allowOwnerWebAuthnRequest(first, 'add-start')).toBe(true);
    expect(allowOwnerWebAuthnRequest(first, 'add-finish')).toBe(true);
  });

  it('refuses missing authenticated owner identifier before rate accounting', () => {
    expect(allowOwnerWebAuthnRequest('', 'approval-start')).toBe(false);
  });
});
