import { describe, expect, test } from 'vitest';
import { calculateManualReceiptTotals, calculateTotalsWithPersonalTips } from './manual-receipt-split';

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
  test('multiple items reconcile exactly', () => {
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
    });
    expect([...totals.values()].reduce((sum, x) => sum + x, 0)).toBe(303);
  });
  test('splitting 505 kopecks adds no mandatory tax or shared tip', () => {
    const result = split(505, [2, 3]);
    expect([...result.values()].reduce((sum, share) => sum + share, 0)).toBe(505);
    expect(result.get('alice')).toBe(202);
    expect(result.get('bob')).toBe(303);
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

describe('individually chosen voluntary tips: exact RUB totals', () => {
  const participants = new Set(['alice', 'bob', 'creator', 'payer']);
  const consumers = new Set(['alice', 'bob']);
  const apply = (tips: unknown, shares = split(101, [3, 5])) =>
    calculateTotalsWithPersonalTips(shares, tips, participants, consumers);

  test('only chosen tips are added to each owner, preserving creator remainder', () => {
    const shares = split(101, [3, 5]);
    const result = apply({ alice: 125, bob: 50, creator: 0 }, shares);
    expect(result).toEqual({
      userTotals: new Map([
        ['alice', 162],
        ['bob', 113],
        ['creator', 1],
      ]),
      itemTotal: 101,
      tipTotal: 175,
      total: 276,
    });
    expect(shares).toEqual(
      new Map([
        ['alice', 37],
        ['bob', 63],
        ['creator', 1],
      ]),
    );
    expect([...result.userTotals.values()].reduce((sum, x) => sum + x, 0)).toBe(result.total);
  });

  test('rejects a positive tip from a person not assigned any dish', () => {
    expect(() => apply({ payer: 99 })).toThrow(RangeError);
    expect(() => apply({ creator: 99 })).toThrow(RangeError);
    // A non-consumer's default 0 ₽ does not create an extra debt.
    expect(apply({ payer: 0 }).tipTotal).toBe(0);
  });

  test('zero or missing tips do not change dish-only amounts', () => {
    const base = split(101, [3, 5]);
    for (const tips of [undefined, null, {}, { alice: 0, bob: 0 }]) {
      const result = apply(tips, base);
      expect(result.userTotals).toEqual(base);
      expect(result.tipTotal).toBe(0);
      expect(result.itemTotal).toBe(101);
      expect(result.total).toBe(101);
    }
  });

  test('tips belong to their owners, not the selected payer', () => {
    const result = apply({ alice: 500, bob: 0 });
    expect(result.userTotals.get('alice')).toBe(537);
    expect(result.userTotals.get('bob')).toBe(63);
    expect(result.userTotals.get('payer')).toBeUndefined();
  });

  test.each([[-1], [1.25], [NaN], [Infinity], [2_147_483_648], ['100'], [null], [{}]])(
    'rejects a malformed tip %s',
    (value) => {
      expect(() => apply({ alice: value })).toThrow(RangeError);
    },
  );

  test.each([3, '100', [], ['x']])('rejects malformed personal tip container %s', (tips) => {
    expect(() => apply(tips)).toThrow(RangeError);
  });

  test('rejects an attempt to charge an unknown member even with zero tip', () => {
    expect(() => apply({ outside: 0 })).toThrow(RangeError);
    expect(() => apply({ outside: 100 })).toThrow(RangeError);
  });

  test('rejects invalid shares and retired members', () => {
    expect(() => apply({}, new Map([['outside', 100]]))).toThrow(RangeError);
    expect(() => apply({}, new Map([['alice', -1]]))).toThrow(RangeError);
    expect(() => apply({}, new Map([['alice', 1.1]]))).toThrow(RangeError);
  });

  test('accepts exactly the DB integer limit but rejects overflow in shares or tips', () => {
    const limit = 2_147_483_647;
    const valid = calculateTotalsWithPersonalTips(
      new Map([['alice', 1]]),
      { alice: limit - 1 },
      participants,
      consumers,
    );
    expect(valid.total).toBe(limit);
    expect(valid.userTotals.get('alice')).toBe(limit);
    expect(() => apply({ alice: limit })).toThrow(RangeError);
    expect(() => apply({ alice: limit - 10 })).toThrow(RangeError);
    expect(() =>
      calculateTotalsWithPersonalTips(
        new Map([
          ['alice', limit],
          ['bob', 1],
        ]),
        {},
        participants,
        consumers,
      ),
    ).toThrow(RangeError);
    expect(() =>
      calculateTotalsWithPersonalTips(new Map([['alice', limit]]), { alice: 1 }, participants, consumers),
    ).toThrow(RangeError);
  });

  test('each participant is billed precisely once for their food and their personal tip', () => {
    const base = calculateManualReceiptTotals({
      items: [
        { id: 'a', totalPrice: 202 },
        { id: 'b', totalPrice: 101 },
      ],
      assignments: [
        { receiptItemId: 'a', people: [{ userId: 'alice', parts: 1 }] },
        { receiptItemId: 'b', people: [{ userId: 'bob', parts: 1 }] },
      ],
      creatorId: 'creator',
    });
    const result = apply({ alice: 25, bob: 75, payer: 0 }, base);
    expect(result.itemTotal).toBe(303);
    expect(result.tipTotal).toBe(100);
    expect(result.total).toBe(403);
    expect(result.userTotals).toEqual(
      new Map([
        ['alice', 227],
        ['bob', 176],
        ['creator', 0],
      ]),
    );
  });
});
