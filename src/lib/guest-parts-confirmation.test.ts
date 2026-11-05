import { describe, expect, test } from 'vitest';
import { guestPartsConfirmationSnapshot as snap } from './guest-parts-confirmation';

describe('2.19.2.2 guest creator approval snapshot', () => {
  const input = {
    items: [{ name: 'Пицца', quantity: 1, totalPrice: 800 }],
    people: [{ id: 'alice' }, { id: 'bob' }],
    assignments: [{ itemIndex: 0, personIndices: [0, 1], partsByPersonId: { alice: 3, bob: 5 } }],
  };
  test('reordering claimants does not invalidate unchanged portions', () => {
    expect(snap({ ...input, assignments: [{ ...input.assignments[0]!, personIndices: [1, 0] }] })).toBe(snap(input));
  });
  test('changing a portion, item price, participant or group size invalidates approval', () => {
    const approved = snap(input);
    expect(
      snap({ ...input, assignments: [{ ...input.assignments[0]!, partsByPersonId: { alice: 4, bob: 5 } }] }),
    ).not.toBe(approved);
    expect(snap({ ...input, items: [{ ...input.items[0]!, totalPrice: 801 }] })).not.toBe(approved);
    expect(snap({ ...input, assignments: [{ itemIndex: 0, personIndices: [0] }] })).not.toBe(approved);
    expect(snap({ ...input, people: [{ id: 'alice', groupSize: 2 }, { id: 'bob' }] })).not.toBe(approved);
  });
  test('no claims is not a fictional portion', () => {
    expect(snap({ ...input, assignments: [] })).toContain('"portions":[]');
  });
});
