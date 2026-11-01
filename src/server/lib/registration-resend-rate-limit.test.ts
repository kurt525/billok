import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rateLimit } = vi.hoisted(() => ({ rateLimit: vi.fn() }));
vi.mock('./rate-limit', () => ({ checkRateLimit: rateLimit }));

import { allowRegistrationVerificationResend } from './registration-resend-rate-limit';

const HOUR_MS = 60 * 60 * 1000;
const emailHash = createHash('sha256').update('person@mail.ru').digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  rateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

describe('registration email resend budget', () => {
  it('checks global, per-IP and case-insensitive per-email quotas without storing the raw address', () => {
    const headers = new Headers({ 'x-real-ip': '192.0.2.18' });
    expect(allowRegistrationVerificationResend(headers, 'Person@MAIL.RU')).toBe(true);
    expect(rateLimit.mock.calls).toEqual([
      ['auth:registration-resend:global', 600, HOUR_MS],
      ['auth:registration-resend:ip:192.0.2.18', 5, HOUR_MS],
      ['auth:registration-resend:email:' + emailHash, 3, HOUR_MS],
    ]);
    expect(JSON.stringify(rateLimit.mock.calls)).not.toContain('Person@MAIL.RU');
  });

  it('fails closed on exhausted global budget before minting an unbounded per-address key', () => {
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 1 });
    expect(allowRegistrationVerificationResend(new Headers(), 'attacker@mail.ru')).toBe(false);
    expect(rateLimit).toHaveBeenCalledExactlyOnceWith('auth:registration-resend:global', 600, HOUR_MS);
  });

  it('uses a shared fallback for unknown IP and refuses requests when the IP quota is exhausted', () => {
    rateLimit.mockReturnValueOnce({ allowed: true, retryAfterMs: 0 });
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 1 });
    expect(allowRegistrationVerificationResend(new Headers(), 'person@mail.ru')).toBe(false);
    expect(rateLimit).toHaveBeenCalledTimes(2);
    expect(rateLimit).toHaveBeenNthCalledWith(2, 'auth:registration-resend:ip:global', 5, HOUR_MS);
  });

  it('rejects a sender when their per-email quota is exhausted despite allowed IP and global quotas', () => {
    rateLimit.mockReturnValueOnce({ allowed: true, retryAfterMs: 0 });
    rateLimit.mockReturnValueOnce({ allowed: true, retryAfterMs: 0 });
    rateLimit.mockReturnValueOnce({ allowed: false, retryAfterMs: 1 });
    expect(allowRegistrationVerificationResend(new Headers({ 'x-real-ip': '192.0.2.19' }), 'PERSON@mail.ru')).toBe(
      false,
    );
    expect(rateLimit).toHaveBeenNthCalledWith(3, 'auth:registration-resend:email:' + emailHash, 3, HOUR_MS);
  });
});
