import { describe, expect, test } from 'vitest';
import { GUEST_PRESENCE_TTL_MS, guestPresenceState } from './guest-presence';

describe('Issue 3.5: joined is not identical to online', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  test('never joined remains never joined even when supplied a timestamp', () => {
    expect(guestPresenceState(false, null, now)).toBe('not-joined');
    expect(guestPresenceState(false, new Date(now), now)).toBe('not-joined');
  });
  test('joined without a heartbeat is distinct from a guest who never entered', () => {
    expect(guestPresenceState(true, null, now)).toBe('joined');
  });
  test('recent heartbeat makes a participant online within its short TTL', () => {
    expect(guestPresenceState(true, new Date(now), now)).toBe('online');
    expect(guestPresenceState(true, new Date(now - GUEST_PRESENCE_TTL_MS + 1), now)).toBe('online');
  });
  test('expired heartbeat means offline, not withdrawn from the receipt', () => {
    expect(guestPresenceState(true, new Date(now - GUEST_PRESENCE_TTL_MS), now)).toBe('offline');
    expect(guestPresenceState(true, new Date(now - 86400000), now)).toBe('offline');
  });
  test('malformed or implausible future timestamps cannot mark someone online', () => {
    expect(guestPresenceState(true, new Date('invalid'), now)).toBe('joined');
    expect(guestPresenceState(true, new Date(now + 10000), now)).toBe('offline');
  });
});
