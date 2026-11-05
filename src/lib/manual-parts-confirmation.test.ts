import { describe, expect, test } from 'vitest';
import { manualPartsConfirmationSnapshot as snapshot } from './manual-parts-confirmation';

describe('2.19.2.1: confirm the exact group receipt before finalization', () => {
  const input = {
    items: [
      { id: 'pizza', totalPrice: 800 },
      { id: 'tea', totalPrice: 100 },
    ],
    assignments: [
      {
        receiptItemId: 'pizza',
        people: [
          { userId: 'alice', parts: 3 },
          { userId: 'bob', parts: 5 },
        ],
      },
      { receiptItemId: 'tea', people: [{ userId: 'alice', parts: 1 }] },
    ],
  };
  test('stable after harmless reordering of assignments and people', () => {
    const reorder = {
      items: [...input.items].reverse(),
      assignments: input.assignments
        .map((a) => ({
          ...a,
          people: [...a.people].reverse(),
        }))
        .reverse(),
    };
    expect(snapshot(reorder)).toBe(snapshot(input));
  });
  test('changes if a declared portion, participant, dish or price changes', () => {
    const approved = snapshot(input);
    expect(
      snapshot({
        ...input,
        assignments: [
          {
            ...input.assignments[0]!,
            people: [
              { userId: 'alice', parts: 4 },
              { userId: 'bob', parts: 5 },
            ],
          },
          input.assignments[1]!,
        ],
      }),
    ).not.toBe(approved);
    expect(snapshot({ ...input, items: [{ id: 'pizza', totalPrice: 801 }, input.items[1]!] })).not.toBe(approved);
    expect(snapshot({ ...input, assignments: [input.assignments[0]!] })).not.toBe(approved);
    expect(
      snapshot({
        ...input,
        assignments: [{ receiptItemId: 'pizza', people: [{ userId: 'bob', parts: 5 }] }, input.assignments[1]!],
      }),
    ).not.toBe(approved);
  });
});
