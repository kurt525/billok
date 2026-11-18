import { describe, test, expect } from 'vitest';
import { formatCents, parseToCents, centsToDecimal, isValidMoneyInput } from './money';

describe('formatCents', () => {
  const normalize = (value: string) => value.replace(/[\u00a0\u202f]/g, ' ');

  test('renders rubles in Russian with exact kopecks', () => {
    expect(normalize(formatCents(0))).toBe('0,00 ₽');
    expect(normalize(formatCents(1))).toBe('0,01 ₽');
    expect(normalize(formatCents(50))).toBe('0,50 ₽');
    expect(normalize(formatCents(1299))).toBe('12,99 ₽');
  });

  test('keeps grouping and negative balances in ru-RU', () => {
    expect(normalize(formatCents(123456))).toBe('1 234,56 ₽');
    expect(normalize(formatCents(10000000))).toBe('100 000,00 ₽');
    expect(normalize(formatCents(-1299))).toBe('-12,99 ₽');
  });

  test('never switches BillOK money rendering to obsolete language locales', () => {
    for (const obsoleteLocale of ['en-US', 'es', 'de', 'fr', 'sv', 'pt-BR', 'ja', 'zh-CN', 'ko']) {
      expect(normalize(formatCents(123456, 'RUB', obsoleteLocale)), obsoleteLocale).toBe('1 234,56 ₽');
    }
  });

  test('preserves historical foreign currency labels without FX conversion', () => {
    expect(normalize(formatCents(100, 'EUR', 'en-US'))).toBe('1,00 €');
    expect(normalize(formatCents(1299, 'USD', 'de-DE'))).toBe('12,99 $');
  });
});

describe('parseToCents', () => {
  test('parses whole numbers', () => {
    expect(parseToCents('10')).toBe(1000);
    expect(parseToCents('1')).toBe(100);
    expect(parseToCents('0')).toBe(0);
  });

  test('parses decimal amounts', () => {
    expect(parseToCents('12.99')).toBe(1299);
    expect(parseToCents('0.01')).toBe(1);
    expect(parseToCents('0.50')).toBe(50);
  });

  test('accepts Russian commas and separated thousands without losing kopecks', () => {
    expect(parseToCents('12,50')).toBe(1250);
    expect(parseToCents('0,01')).toBe(1);
    expect(parseToCents('1 234,56')).toBe(123456);
    expect(parseToCents('1\u00a0234,56')).toBe(123456);
    expect(parseToCents('1\u202f234,56')).toBe(123456);
    expect(parseToCents('-12,50')).toBe(-1250);
    expect(parseToCents('12,50')).toBe(parseToCents('12.50'));
    expect(formatCents(parseToCents('1 234,56')).replace(/[\u00a0\u202f]/g, ' ')).toBe('1 234,56 ₽');
  });

  test('can distinguish a valid zero-kopeck amount from invalid entered text', () => {
    expect(isValidMoneyInput('0,00')).toBe(true);
    expect(isValidMoneyInput('1 234,50')).toBe(true);
    expect(isValidMoneyInput('не сумма')).toBe(false);
  });

  test('rejects ambiguous or malformed grouping instead of misinterpreting a receipt', () => {
    expect(parseToCents('12,50,00')).toBe(0);
    expect(parseToCents('1 23,45')).toBe(0);
    expect(parseToCents('1.234,56')).toBe(0);
    expect(parseToCents('12 руб')).toBe(0);
  });

  test('rounds monetary values half-up to the nearest kopeck', () => {
    expect(parseToCents('12.999')).toBe(1300);
    expect(parseToCents('12,994')).toBe(1299);
    expect(parseToCents('12,995')).toBe(1300);
    expect(parseToCents('0,005')).toBe(1);
    expect(parseToCents('-0,005')).toBe(-1);
  });

  test('avoids floating-point corruption in decimal rounding', () => {
    expect(parseToCents('1.005')).toBe(101);
    expect(parseToCents('2.675')).toBe(268);
    expect(parseToCents('1.15')).toBe(115);
  });

  test('returns 0 for invalid input', () => {
    expect(parseToCents('')).toBe(0);
    expect(parseToCents('abc')).toBe(0);
    expect(parseToCents('not-a-number')).toBe(0);
  });

  test('handles negative values', () => {
    expect(parseToCents('-10.50')).toBe(-1050);
  });
});

describe('centsToDecimal', () => {
  test('converts cents to decimal string', () => {
    expect(centsToDecimal(1299)).toBe('12.99');
    expect(centsToDecimal(1000)).toBe('10.00');
    expect(centsToDecimal(1)).toBe('0.01');
    expect(centsToDecimal(0)).toBe('0.00');
  });

  test('handles large amounts', () => {
    expect(centsToDecimal(10000000)).toBe('100000.00');
  });

  test('handles negative amounts', () => {
    expect(centsToDecimal(-1299)).toBe('-12.99');
  });
});
