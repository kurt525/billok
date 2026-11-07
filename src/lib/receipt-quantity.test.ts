import { describe, expect, it } from 'vitest';
import { parseReceiptQuantity } from './receipt-quantity';

describe('receipt item quantity validation', () => {
  it('accepts positive whole quantities', () => {
    expect(parseReceiptQuantity('1')).toBe(1);
    expect(parseReceiptQuantity('12')).toBe(12);
    expect(parseReceiptQuantity(' 3 ')).toBe(3);
  });

  it('rejects partial, zero, decimal and unsafe quantities', () => {
    for (const value of ['', '0', '-2', '2.5', '2,5', '2items', 'NaN', '9007199254740992']) {
      expect(parseReceiptQuantity(value), value).toBeNull();
    }
  });
});
