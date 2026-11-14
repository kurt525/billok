import { describe, expect, test } from 'vitest';
import { manualKnownPartsBalance } from './manual-known-parts';

const items = ['pizza', 'drink'];
const assignments = [
  { receiptItemId: 'pizza', parts: [3, 5] },
  { receiptItemId: 'drink', parts: [1] },
];

describe('2.20.1 known original counts are an optional strict limit', () => {
  test('unknown count has no artificial remainder or cap', () => {
    expect(manualKnownPartsBalance({ itemIds: items, declaredTotalPartsByItem: {}, assignments })).toEqual({
      progressByItem: {},
      overclaimed: false,
      hasRemaining: false,
    });
  });
  test('known total 10 reports 8 counted and 2 unassigned', () => {
    const state = manualKnownPartsBalance({
      itemIds: items,
      declaredTotalPartsByItem: { pizza: 10 },
      assignments,
    });
    expect(state.progressByItem.pizza).toEqual({ countedParts: 8, remainingParts: 2, overclaimed: false });
    expect(state.hasRemaining).toBe(true);
    expect(state.overclaimed).toBe(false);
  });
  test('known total 8 and drink 1 are fully allocated without new charges', () => {
    const state = manualKnownPartsBalance({
      itemIds: items,
      declaredTotalPartsByItem: { pizza: 8, drink: 1 },
      assignments,
    });
    expect(state.overclaimed).toBe(false);
    expect(state.hasRemaining).toBe(false);
  });
  test('known total 7 refuses an eight-part claim without truncating shares', () => {
    const state = manualKnownPartsBalance({
      itemIds: items,
      declaredTotalPartsByItem: { pizza: 7 },
      assignments,
    });
    expect(state.overclaimed).toBe(true);
    expect(state.progressByItem.pizza?.countedParts).toBe(8);
  });
  test('known but unclaimed item has a full outstanding remainder', () => {
    const state = manualKnownPartsBalance({
      itemIds: items,
      declaredTotalPartsByItem: { drink: 3 },
      assignments: [assignments[0]!],
    });
    expect(state.progressByItem.drink).toEqual({ countedParts: 0, remainingParts: 3, overclaimed: false });
  });
  test('invalid limits and invalid claims do not look like a valid allocation', () => {
    for (const invalid of [0, -1, 1.5, 10001, '8']) {
      expect(() =>
        manualKnownPartsBalance({
          itemIds: items,
          declaredTotalPartsByItem: { pizza: invalid },
          assignments,
        }),
      ).toThrow(RangeError);
    }
    expect(() =>
      manualKnownPartsBalance({
        itemIds: items,
        declaredTotalPartsByItem: { pizza: 8 },
        assignments: [{ receiptItemId: 'pizza', parts: [0] }],
      }),
    ).toThrow(RangeError);
  });
});
