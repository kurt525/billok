import { describe, expect, test } from 'vitest';
import { calculateManualReceiptTotals } from './manual-receipt-split';

const split = (amount: number, parts: number[], creatorId = 'creator') =>
  calculateManualReceiptTotals({
    items: [{ id: 'pizza', totalPrice: amount }],
    assignments: [
      {
        receiptItemId: 'pizza',
        people: [
          { userId: 'alice', parts: parts[0]! },
          { userId: 'bob', parts: parts[1]! },
        ],
      },
    ],
    creatorId,
  });

describe('manual item splitting by consumed parts', () => {
  test('3 and 5 portions with no known original count', () => {
    expect([...split(800, [3, 5])]).toEqual([
      ['alice', 300],
      ['bob', 500],
      ['creator', 0],
    ]);
  });
  test('remaining kopeck belongs to creator, not payer or last consumer', () => {
    expect([...split(101, [3, 5])]).toEqual([
      ['alice', 37],
      ['bob', 63],
      ['creator', 1],
    ]);
  });
  test('creator gets their proportional consumption plus remainder', () => {
    expect([...split(101, [3, 5], 'alice')]).toEqual([
      ['alice', 38],
      ['bob', 63],
    ]);
  });
  test('one kopeck also reconciles', () => {
    const result = split(1, [3, 5]);
    expect([...result.values()].reduce((sum, x) => sum + x, 0)).toBe(1);
    expect(result.get('creator')).toBe(1);
  });
  test('tip and multiple items reconcile exactly', () => {
    const totals = calculateManualReceiptTotals({
      items: [
        { id: 'a', totalPrice: 101 },
        { id: 'b', totalPrice: 202 },
      ],
      assignments: [
        {
          receiptItemId: 'a',
          people: [
            { userId: 'alice', parts: 3 },
            { userId: 'bob', parts: 5 },
          ],
        },
        { receiptItemId: 'b', people: [{ userId: 'bob', parts: 1 }] },
      ],
      creatorId: 'creator',
      tip: 37,
    });
    expect([...totals.values()].reduce((sum, x) => sum + x, 0)).toBe(340);
  });
  test('invalid and duplicate consumed parts are refused', () => {
    expect(() => split(100, [0, 5])).toThrow(RangeError);
    expect(() => split(100, [3.5, 5])).toThrow(RangeError);
    expect(() =>
      calculateManualReceiptTotals({
        items: [{ id: 'i', totalPrice: 100 }],
        assignments: [
          {
            receiptItemId: 'i',
            people: [
              { userId: 'alice', parts: 1 },
              { userId: 'alice', parts: 2 },
            ],
          },
        ],
        creatorId: 'creator',
      }),
    ).toThrow(RangeError);
  });
});
