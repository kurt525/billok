import { describe, expect, test } from 'vitest';
import { isSupportedSbpBankId, normalizeSbpPhone, SBP_BANKS } from './sbp-banks';

describe('SBP profile contracts', () => {
  test('normalizes common Russian dialling formats without verification', () => {
    expect(normalizeSbpPhone('8 (999) 123-45-67')).toBe('+79991234567');
    expect(normalizeSbpPhone('+7 999 123 45 67')).toBe('+79991234567');
    expect(normalizeSbpPhone('79991234567')).toBe('+79991234567');
  });

  test('rejects invalid, international and incomplete numbers', () => {
    for (const value of ['', '123', '+15551234567', '8999123456', '+7 999 123 45 6a']) {
      expect(normalizeSbpPhone(value)).toBeNull();
    }
  });

  test('has unique bank IDs and rejects unlisted values', () => {
    expect(new Set(SBP_BANKS.map((bank) => bank.id)).size).toBe(SBP_BANKS.length);
    expect(isSupportedSbpBankId('tbank')).toBe(true);
    expect(isSupportedSbpBankId('unknown-bank')).toBe(false);
  });
});
