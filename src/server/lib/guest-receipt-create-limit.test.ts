import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The real rate-limit store starts a cleanup interval at import time.
vi.useFakeTimers();
const { checkGuestReceiptCreationLimit, DEFAULT_RECEIPT_CREATE_BURST, RECEIPT_CREATE_BURST_WINDOW_MS } =
  await import('./guest-receipt-create-limit');

beforeEach(() => {
  vi.advanceTimersByTime(5 * 60_000); // expire every previous test's account window
  vi.stubEnv('GUEST_RATE_LIMIT_MAX', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('Issue 3.23: authenticated receipt creation is burst-limited, not IP/hour quota-limited', () => {
  test('legitimate creator can make more than ten receipts in a minute', () => {
    expect(DEFAULT_RECEIPT_CREATE_BURST).toBe(60);
    for (let i = 0; i < 15; i++) {
      expect(checkGuestReceiptCreationLimit('registered-person-a')).toBe(true);
    }
  });

  test('a rapid automated creation flood hits the one-minute budget, then recovers', () => {
    for (let i = 0; i < DEFAULT_RECEIPT_CREATE_BURST; i++) {
      expect(checkGuestReceiptCreationLimit('registered-person-b')).toBe(true);
    }
    expect(checkGuestReceiptCreationLimit('registered-person-b')).toBe(false);
    vi.advanceTimersByTime(RECEIPT_CREATE_BURST_WINDOW_MS + 1);
    expect(checkGuestReceiptCreationLimit('registered-person-b')).toBe(true);
    // No hour/day/lifetime limit or cumulative receipt counter remains.
  });

  test('people behind the same IP do not consume each others account budgets', () => {
    vi.stubEnv('GUEST_RATE_LIMIT_MAX', '2');
    expect(checkGuestReceiptCreationLimit('registered-person-c')).toBe(true);
    expect(checkGuestReceiptCreationLimit('registered-person-c')).toBe(true);
    expect(checkGuestReceiptCreationLimit('registered-person-c')).toBe(false);
    expect(checkGuestReceiptCreationLimit('registered-person-d')).toBe(true);
    expect(checkGuestReceiptCreationLimit('registered-person-d')).toBe(true);
  });

  test('invalid or zero environment settings cannot silently disable protection', () => {
    for (const invalid of ['0', '-1', 'not-an-integer']) {
      vi.stubEnv('GUEST_RATE_LIMIT_MAX', invalid);
      expect(checkGuestReceiptCreationLimit('registered-' + invalid)).toBe(true);
    }
    expect(DEFAULT_RECEIPT_CREATE_BURST).toBeGreaterThan(0);
  });
});
