import { describe, expect, test } from 'vitest';
import {
  calculateManualReceiptTotals,
  calculateManualReceiptAllocation,
  calculateTotalsWithPersonalTips,
  manualPortionProgress,
} from './manual-receipt-split';

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
  test('2.17.1 exposes non-consumption organizer correction without adding a receipt item', () => {
    const params = {
      items: [{ id: 'pizza', totalPrice: 101 }],
      assignments: [
        {
          receiptItemId: 'pizza',
          people: [
            { userId: 'alice', parts: 3 },
            { userId: 'bob', parts: 5 },
          ],
        },
      ],
      creatorId: 'organizer',
    };
    const allocation = calculateManualReceiptAllocation(params);
    expect(allocation.organizerCorrectionCents).toBe(1);
    expect(allocation.totals).toEqual(
      new Map([
        ['alice', 37],
        ['bob', 63],
        ['organizer', 1],
      ]),
    );
    // This meta-field is not another assignment or another line item.
    expect(params.assignments[0]!.people.map((p) => p.userId)).toEqual(['alice', 'bob']);
    expect(allocation.totals).toEqual(calculateManualReceiptTotals(params));
    expect([...allocation.totals.values()].reduce((sum, x) => sum + x, 0)).toBe(101);
  });

  test('2.17.1 creator may also consume the dish; only the remainder is separate', () => {
    const params = {
      items: [{ id: 'pizza', totalPrice: 101 }],
      assignments: [
        {
          receiptItemId: 'pizza',
          people: [
            { userId: 'alice', parts: 3 },
            { userId: 'bob', parts: 5 },
          ],
        },
      ],
      creatorId: 'alice',
    };
    expect(calculateManualReceiptAllocation(params)).toEqual({
      totals: new Map([
        ['alice', 38],
        ['bob', 63],
      ]),
      organizerCorrectionCents: 1,
    });
  });

  test('2.17.1 balanced multi-item allocation has no separate organizer correction', () => {
    const params = {
      items: [
        { id: 'a', totalPrice: 101 },
        { id: 'b', totalPrice: 101 },
      ],
      assignments: [
        {
          receiptItemId: 'a',
          people: [
            { userId: 'alice', parts: 3 },
            { userId: 'bob', parts: 5 },
          ],
        },
        {
          receiptItemId: 'b',
          people: [
            { userId: 'alice', parts: 3 },
            { userId: 'bob', parts: 5 },
          ],
        },
      ],
      creatorId: 'organizer',
    };
    expect(calculateManualReceiptAllocation(params)).toEqual({
      totals: new Map([
        ['alice', 76],
        ['bob', 126],
        ['organizer', 0],
      ]),
      organizerCorrectionCents: 0,
    });
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
  test('2.16 balances cross-item remainders among actual consumers rather than charging creator', () => {
    const totals = calculateManualReceiptTotals({
      items: [
        { id: 'a', totalPrice: 101 },
        { id: 'b', totalPrice: 101 },
      ],
      assignments: [
        {
          receiptItemId: 'a',
          people: [
            { userId: 'alice', parts: 3 },
            { userId: 'bob', parts: 5 },
          ],
        },
        {
          receiptItemId: 'b',
          people: [
            { userId: 'alice', parts: 3 },
            { userId: 'bob', parts: 5 },
          ],
        },
      ],
      creatorId: 'organizer',
    });
    // Alice's exact share is 75.75 kopecks, Bob's 126.25.
    expect([...totals]).toEqual([
      ['alice', 76],
      ['bob', 126],
      ['organizer', 0],
    ]);
  });

  test('2.16 opposite fractional deficits cancel across independent items', () => {
    const totals = calculateManualReceiptTotals({
      items: [
        { id: 'a', totalPrice: 101 },
        { id: 'b', totalPrice: 101 },
      ],
      assignments: [
        {
          receiptItemId: 'a',
          people: [
            { userId: 'alice', parts: 3 },
            { userId: 'bob', parts: 5 },
          ],
        },
        {
          receiptItemId: 'b',
          people: [
            { userId: 'alice', parts: 5 },
            { userId: 'bob', parts: 3 },
          ],
        },
      ],
      creatorId: 'organizer',
    });
    expect([...totals]).toEqual([
      ['alice', 101],
      ['bob', 101],
      ['organizer', 0],
    ]);
  });

  test('2.16 handles multiple 1-kopeck dishes with three consumers', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ id: String(i), totalPrice: 1 }));
    const assignments = items.map(({ id }) => ({
      receiptItemId: id,
      people: [
        { userId: 'alice', parts: 1 },
        { userId: 'bob', parts: 1 },
        { userId: 'carol', parts: 1 },
      ],
    }));
    const totals = calculateManualReceiptTotals({ items, assignments, creatorId: 'organizer' });
    expect([...totals]).toEqual([
      ['alice', 3],
      ['bob', 3],
      ['carol', 3],
      ['organizer', 0],
    ]);
  });

  test('2.16 never creates negative shares or distributes an item to non-consumers', () => {
    const totals = calculateManualReceiptTotals({
      items: [
        { id: 'a', totalPrice: 1 },
        { id: 'b', totalPrice: 100 },
      ],
      assignments: [
        {
          receiptItemId: 'a',
          people: [
            { userId: 'alice', parts: 1 },
            { userId: 'bob', parts: 1 },
          ],
        },
        { receiptItemId: 'b', people: [{ userId: 'carol', parts: 1 }] },
      ],
      creatorId: 'organizer',
    });
    expect([...totals.values()].reduce((sum, amount) => sum + amount, 0)).toBe(101);
    expect(totals.get('carol')).toBe(100);
    expect([...totals.values()].every((amount) => amount >= 0)).toBe(true);
    expect(totals.get('organizer')).toBe(0);
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

describe('optional original portion count for a hand-entered item', () => {
  test('3 and 5 consumed portions need no known original amount', () => {
    expect(manualPortionProgress([3, 5])).toEqual({
      countedParts: 8,
      declaredTotalParts: null,
      remainingParts: null,
      overclaimed: false,
    });
    expect(manualPortionProgress([3, 5], null).remainingParts).toBeNull();
  });
  test('a known total is a separate control, not a pricing denominator', () => {
    expect(manualPortionProgress([3, 5], 10)).toEqual({
      countedParts: 8,
      declaredTotalParts: 10,
      remainingParts: 2,
      overclaimed: false,
    });
    expect(manualPortionProgress([3, 5], 8).remainingParts).toBe(0);
    expect(manualPortionProgress([3, 5], 7).overclaimed).toBe(true);
    expect(split(800, [3, 5]).get('alice')).toBe(300);
  });
  test.each([0, -1, 2.5, 10001, Number.NaN, Infinity])('rejects invalid total %s', (n) => {
    expect(() => manualPortionProgress([3, 5], n)).toThrow(RangeError);
  });
  test.each([0, -1, 1.5, 10001, Number.NaN, Infinity])('rejects invalid claim %s', (n) => {
    expect(() => manualPortionProgress([n])).toThrow(RangeError);
  });
});
