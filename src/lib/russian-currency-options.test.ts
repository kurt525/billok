import { describe, expect, it } from 'vitest';
import { COMMON_CURRENCIES, getCurrencyLabel } from '@/lib/currencies';

describe('Russian ruble currency selector regression', () => {
  it('offers RUB as the default, visible selectable currency', () => {
    expect(COMMON_CURRENCIES[0]).toEqual({
      code: 'RUB',
      name: 'Российский рубль',
      symbol: '₽',
    });
    expect(getCurrencyLabel('RUB')).toBe('RUB - Российский рубль');
  });

  it('contains unique codes and preserves other currencies', () => {
    const codes = COMMON_CURRENCIES.map((currency) => currency.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('EUR');
    expect(codes).toContain('USD');
  });
});
