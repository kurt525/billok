import { describe, expect, test } from 'vitest';
import {
  formatSbpPhoneForDisplay,
  isSupportedSbpBankId,
  normalizeSbpPhone,
  sbpPhoneForBankInput,
  SBP_BANKS,
  searchSbpBanks,
} from './sbp-banks';

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

  test('searches the bank registry snapshot, ignoring case, spaces and hyphens', () => {
    expect(searchSbpBanks('АК БАРС').map((bank) => bank.id)).toEqual(['akbars']);
    expect(searchSbpBanks('акбарс').map((bank) => bank.id)).toEqual(['akbars']);
    expect(searchSbpBanks('тИнЬкОфФ').map((bank) => bank.id)).toEqual(['tbank']);
    expect(searchSbpBanks('T-BANK').map((bank) => bank.id)).toEqual(['tbank']);
    expect(searchSbpBanks('СБЕР').map((bank) => bank.id)).toEqual(['sberbank']);
    expect(searchSbpBanks('Озон').some((bank) => bank.id === '100000000273')).toBe(true);
    expect(searchSbpBanks('Яндекс').some((bank) => bank.id === '100000000150')).toBe(true);
    expect(searchSbpBanks('Банк ПСБ').some((bank) => bank.id === '100000000010')).toBe(true);
    expect(searchSbpBanks('несуществующий банк')).toEqual([]);
    expect(searchSbpBanks('  ')).toHaveLength(SBP_BANKS.length);
  });

  test('has unique bank IDs and rejects unlisted values', () => {
    expect(new Set(SBP_BANKS.map((bank) => bank.id)).size).toBe(SBP_BANKS.length);
    expect(SBP_BANKS.length).toBeGreaterThanOrEqual(100);
    expect(new Set(SBP_BANKS.map((bank) => bank.nspkId)).size).toBe(SBP_BANKS.length);
    expect(isSupportedSbpBankId('tbank')).toBe(true);
    expect(isSupportedSbpBankId('100000000273')).toBe(true);
    expect(isSupportedSbpBankId('100000000150')).toBe(true);
    expect(isSupportedSbpBankId('unknown-bank')).toBe(false);
  });
});

describe('Issue 4.8: manual SBP phone display and bank-app paste', () => {
  test.each([
    ['+79991234567', '+7 (999) 123-45-67', '9991234567'],
    ['8 (999) 123-45-67', '+7 (999) 123-45-67', '9991234567'],
    ['+7 900 000 00 01', '+7 (900) 000-00-01', '9000000001'],
  ])('formats %s for reading and bank input', (input, display, digits) => {
    expect(formatSbpPhoneForDisplay(input)).toBe(display);
    expect(sbpPhoneForBankInput(input)).toBe(digits);
  });
  test.each(['+15551234567', '+7000000000', '5551234567', 'abc'])('refuses invalid phone: %s', (input) => {
    expect(formatSbpPhoneForDisplay(input)).toBeNull();
    expect(sbpPhoneForBankInput(input)).toBeNull();
  });
});
