import { describe, expect, test } from 'vitest';
import { calculateSplitTotals, calculateClaimTotals, personItemShares } from './split-calculator';
import { guestPortionAssignments, guestPortionProgress, materializeGuestPersonalParts } from './guest-portions';
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

describe('Issue 3.19: persistent consumed parts per claimant', () => {
  const participants = [
    { id: 'alice', groupSize: 3 },
    { id: 'bob', groupSize: 1 },
  ];

  test('new claims get independent explicit counts even if none were customized', () => {
    const persisted = materializeGuestPersonalParts([{ itemIndex: 0, personIndices: [0, 1] }], participants);
    expect(persisted).toEqual([{ itemIndex: 0, personIndices: [0, 1], partsByPersonId: { alice: 3, bob: 1 } }]);
    const rows = calculateSplitTotals({
      ...bill(101),
      assignments: guestPortionAssignments(persisted, participants),
    });
    expect(rows.map((row) => row.itemTotal)).toEqual([76, 25]);
    expect(guestPortionProgress(persisted[0]!, participants)).toEqual({
      countedParts: 4,
      remainingParts: null,
    });
    expect(guestPortionProgress(persisted[0]!, participants, 5)).toEqual({
      countedParts: 4,
      remainingParts: 1,
    });
  });

  test('another claimant joining or leaving preserves recorded parts by stable person ID', () => {
    const before = [{ itemIndex: 0, personIndices: [0], partsByPersonId: { alice: 5 } }];
    const joined = materializeGuestPersonalParts([{ ...before[0]!, personIndices: [0, 1] }], participants);
    expect(joined[0]!.partsByPersonId).toEqual({ alice: 5, bob: 1 });
    const after = materializeGuestPersonalParts([{ ...joined[0]!, personIndices: [1] }], participants);
    expect(after[0]!.partsByPersonId).toEqual({ bob: 1 });
    expect(guestPortionAssignments(joined, participants)[0]!.portions).toEqual([5, 1]);
  });

  test('legacy rows upgrade with the same weighting; irrelevant prior names and IDs are pruned', () => {
    const old = [{ itemIndex: 0, personIndices: [0, 1], partsByPersonId: { removed: 100, alice: 2 } }];
    const upgraded = materializeGuestPersonalParts(old, participants);
    expect(upgraded[0]!.partsByPersonId).toEqual({ alice: 2, bob: 1 });
    const rows = calculateSplitTotals({
      ...bill(101),
      assignments: guestPortionAssignments(upgraded, participants),
    });
    expect(rows.reduce((sum, row) => sum + row.itemTotal, 0)).toBe(101);
  });

  test('invalid prior count cannot silently become a new guest share', () => {
    expect(() =>
      materializeGuestPersonalParts(
        [{ itemIndex: 0, personIndices: [0], partsByPersonId: { alice: 0 } }],
        participants,
      ),
    ).toThrow(RangeError);
  });
});
