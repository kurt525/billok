import { describe, expect, it } from 'vitest';
import { parseRussianPercentage } from './russian-percentage';

describe('Russian mobile percentage entry', () => {
  it('accepts decimals from Russian Android keyboards and percentages with two digits', () => {
    expect(parseRussianPercentage('12,50')).toBe(12.5);
    expect(parseRussianPercentage('12.50')).toBe(12.5);
    expect(parseRussianPercentage(' 100 ')).toBe(100);
    expect(parseRussianPercentage('0,01')).toBe(0.01);
    expect(parseRussianPercentage('0')).toBe(0);
  });

  it('rejects incomplete numbers, extra decimals and out-of-range values', () => {
    for (const invalid of ['', ',', '.', '50foo', '50,', '1,005', '-1', '100,01', '1e2', '12,5,0']) {
      expect(parseRussianPercentage(invalid), invalid).toBeNull();
    }
  });
});
