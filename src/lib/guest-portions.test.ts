import { describe, expect, test } from 'vitest';
import { calculateSplitTotals, calculateClaimTotals, personItemShares } from './split-calculator';
import { guestPortionAssignments, guestPortionProgress } from './guest-portions';
import { manualPortionProgress } from './manual-receipt-split';

const people = [{ id: 'alice' }, { id: 'bob' }];
const original = [{ itemIndex: 0, personIndices: [0, 1] }];
const claimed = [{ itemIndex: 0, personIndices: [0, 1], partsByPersonId: { alice: 3, bob: 5 } }];
const bill = (price: number) => ({
  items: [{ totalPrice: price }],
  tax: 0,
  tip: 0,
  peopleCount: 2,
});

describe('Issue 2.14: both guest portion modes and RUB reconciliation', () => {
  test('unknown original: 3 + 5 are denominator 8; no implied whole pizza', () => {
    expect(guestPortionProgress(claimed[0]!, people)).toEqual({ countedParts: 8, remainingParts: null });
    const rows = calculateSplitTotals({ ...bill(800), assignments: guestPortionAssignments(claimed, people) });
    expect(rows.map((row) => row.total)).toEqual([300, 500]);
  });
  test('known original: 10 is control only; price still split by declared 3/8 and 5/8', () => {
    expect(guestPortionProgress(claimed[0]!, people, 10)).toEqual({ countedParts: 8, remainingParts: 2 });
    expect(manualPortionProgress([3, 5], 10)).toMatchObject({ countedParts: 8, remainingParts: 2 });
    const rows = calculateSplitTotals({ ...bill(101), assignments: guestPortionAssignments(claimed, people) });
    expect(rows.map((row) => row.itemTotal)).toEqual([38, 63]);
    expect(rows.reduce((sum, row) => sum + row.total, 0)).toBe(101);
    const detail = personItemShares(0, {
      items: bill(101).items,
      assignments: guestPortionAssignments(claimed, people),
    });
    expect(detail[0]).toEqual({ itemIndex: 0, amount: 38, share: { numerator: 3, denominator: 8 } });
  });
  test('legacy claims stay equal when no one entered personal parts', () => {
    const rows = calculateSplitTotals({ ...bill(101), assignments: guestPortionAssignments(original, people) });
    expect(rows.map((row) => row.total)).toEqual([51, 50]);
  });
  test('changing one personal count immediately recalculates preview without new charges', () => {
    const assignments = guestPortionAssignments([{ ...claimed[0]!, partsByPersonId: { alice: 2, bob: 5 } }], people);
    const preview = calculateClaimTotals({ ...bill(101), assignments });
    expect(preview.people.reduce((sum, entry) => sum + entry.itemTotal, 0)).toBe(101);
    expect(preview.people.map((entry) => entry.itemTotal)).toEqual([29, 72]);
    expect(preview.unclaimed).toBeNull();
  });
  test('multiple items reconcile kopecks, regardless of known original count', () => {
    const assignments = guestPortionAssignments(
      [...claimed, { itemIndex: 1, personIndices: [0], partsByPersonId: { alice: 2 } }],
      people,
    );
    const rows = calculateSplitTotals({
      items: [{ totalPrice: 101 }, { totalPrice: 201 }],
      assignments,
      tax: 0,
      tip: 0,
      peopleCount: 2,
    });
    expect(rows.reduce((sum, entry) => sum + entry.total, 0)).toBe(302);
  });
  test.each([0, -1, 1.5, 10001])('invalid personal part %s is rejected', (value) => {
    expect(() => guestPortionAssignments([{ ...claimed[0]!, partsByPersonId: { alice: value } }], people)).toThrow(
      RangeError,
    );
  });
});
