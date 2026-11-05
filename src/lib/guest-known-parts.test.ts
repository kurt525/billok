import { describe, expect, test } from 'vitest';
import { guestKnownPartsBalance } from './guest-known-parts';

const fixture = {
  items: [{ name: 'Пицца' }, { name: 'Чай' }],
  people: [
    { id: 'alice', groupSize: 1 },
    { id: 'bob', groupSize: 1 },
  ],
  assignments: [
    { itemIndex: 0, personIndices: [0, 1], partsByPersonId: { alice: 3, bob: 5 } },
    { itemIndex: 1, personIndices: [1] },
  ],
};
describe('2.20.2 guest optional known original portions', () => {
  test('unknown origin has no imaginary remainder or cap', () => {
    expect(guestKnownPartsBalance({ ...fixture, knownPartsByItem: undefined })).toEqual({
      progressByItem: {},
      hasRemaining: false,
      overclaimed: false,
    });
  });
  test('known 10 shows counted 8 and 2 remaining; 8 is complete', () => {
    const remaining = guestKnownPartsBalance({ ...fixture, knownPartsByItem: { 0: 10 } });
    expect(remaining.progressByItem['0']).toEqual({ countedParts: 8, remainingParts: 2, overclaimed: false });
    expect(remaining.hasRemaining).toBe(true);
    const complete = guestKnownPartsBalance({ ...fixture, knownPartsByItem: { 0: 8, 1: 1 } });
    expect(complete.overclaimed).toBe(false);
    expect(complete.hasRemaining).toBe(false);
  });
  test('a claim exceeding known original cannot be stored', () => {
    expect(guestKnownPartsBalance({ ...fixture, knownPartsByItem: { 0: 7 } }).overclaimed).toBe(true);
  });
  test('person group size counts when no explicit personal part value exists', () => {
    const input = {
      ...fixture,
      people: [
        { id: 'alice', groupSize: 3 },
        { id: 'bob', groupSize: 5 },
      ],
      assignments: [{ itemIndex: 0, personIndices: [0, 1] }],
    };
    expect(guestKnownPartsBalance({ ...input, knownPartsByItem: { 0: 10 } }).progressByItem['0']).toEqual({
      countedParts: 8,
      remainingParts: 2,
      overclaimed: false,
    });
  });
  test('rejects invalid, stale or extraneous known counts', () => {
    for (const limits of [{ 0: 0 }, { 0: 10001 }, { 0: '8' }, { 2: 8 }, { '-1': 8 }, []]) {
      expect(() => guestKnownPartsBalance({ ...fixture, knownPartsByItem: limits })).toThrow(RangeError);
    }
  });
});
