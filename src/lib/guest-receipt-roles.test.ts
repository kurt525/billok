import { describe, expect, test } from 'vitest';
import { guestReceiptRoleFlags, organizerPersonIndex } from './guest-receipt-roles';

describe('Issue 3.10: creator and one payer per receipt', () => {
  const people = [
    { id: 'creator-id', name: 'Алексей' },
    { id: 'guest-1', name: 'Илья' },
    { id: 'guest-2', name: 'Алексей П.' },
  ];

  test('independent creator and payer role flags come from distinct server IDs/indices', () => {
    const creator = organizerPersonIndex(people, 'creator-id');
    expect(creator).toBe(0);
    expect(guestReceiptRoleFlags(0, creator, 2, people.length)).toEqual({
      isCreator: true,
      isPayer: false,
    });
    expect(guestReceiptRoleFlags(2, creator, 2, people.length)).toEqual({
      isCreator: false,
      isPayer: true,
    });
    expect(guestReceiptRoleFlags(1, creator, 2, people.length)).toEqual({
      isCreator: false,
      isPayer: false,
    });
  });

  test('when one person is both creator and payer, both flags remain visible', () => {
    expect(guestReceiptRoleFlags(0, 0, 0, 3)).toEqual({ isCreator: true, isPayer: true });
    expect([0, 1, 2].filter((i) => guestReceiptRoleFlags(i, 0, 0, 3).isPayer)).toEqual([0]);
  });

  test('renaming or reordering does not reassign the creator role', () => {
    const renamed = [{ ...people[2]!, name: 'Сергей' }, people[0]!, people[1]!];
    const idx = organizerPersonIndex(renamed, 'creator-id');
    expect(idx).toBe(1);
    expect(guestReceiptRoleFlags(idx, idx, 0, renamed.length)).toEqual({
      isCreator: true,
      isPayer: false,
    });
  });

  test('no fallback from BillOK admin account, name, or payer if creator identity is absent', () => {
    const unknown = organizerPersonIndex(people, undefined);
    expect(unknown).toBe(-1);
    expect(guestReceiptRoleFlags(0, unknown, 1, people.length)).toEqual({
      isCreator: false,
      isPayer: false,
    });
    expect(guestReceiptRoleFlags(1, unknown, 1, people.length)).toEqual({
      isCreator: false,
      isPayer: true,
    });
  });

  test('negative/out-of-range role indices render neither role', () => {
    for (const index of [-1, 3, 99]) {
      expect(guestReceiptRoleFlags(index, 0, 0, people.length)).toEqual({
        isCreator: false,
        isPayer: false,
      });
    }
  });
});
