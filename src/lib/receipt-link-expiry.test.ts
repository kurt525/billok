import { describe, expect, it } from 'vitest';
import { formatReceiptLinkExpiry } from './receipt-link-expiry';

describe('receipt link expiration in Moscow time', () => {
  it('displays the next Moscow calendar day at midnight, including seconds', () => {
    const actual = formatReceiptLinkExpiry('2026-11-22T21:00:01.000Z');
    expect(actual).toContain('23 ноября 2026');
    expect(actual).toContain('00:00:01');
  });

  it('formats the same instant independently of the supplied offset and input type', () => {
    const expected = formatReceiptLinkExpiry('2026-11-22T06:38:52.000Z');
    expect(expected).toContain('22 ноября 2026');
    expect(expected).toContain('09:38:52');
    expect(formatReceiptLinkExpiry('2026-11-22T09:38:52+03:00')).toBe(expected);
    expect(formatReceiptLinkExpiry(new Date('2026-11-21T22:38:52-08:00'))).toBe(expected);
  });
});
