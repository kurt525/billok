import { describe, expect, test } from 'vitest';
import { aggregateReceiptPaymentGroups, receiptPaymentMemberships } from './receipt-payment-groups';

const payer = { id: 'payer' };
const wife = { id: 'wife', paymentGroupRepresentativeId: 'wife' };
const husband = { id: 'husband', paymentGroupRepresentativeId: 'wife' };
const child = { id: 'child', paymentGroupRepresentativeId: 'wife' };
const members = [payer, wife, husband, child];

describe('Issue 3.24.1.1: one receipt, separate diners, one reimbursement for a family', () => {
  test('keeps three personal portions and tips, but one group debt', () => {
    const source = [
      { personIndex: 0, total: 0, tip: 0 },
      { personIndex: 1, total: 321, tip: 0 },
      { personIndex: 2, total: 462, tip: 0 },
      { personIndex: 3, total: 267, tip: 50 },
    ];
    const untouched = structuredClone(source);
    const result = aggregateReceiptPaymentGroups(members, 0, source, 1000);
    expect(result).toMatchObject({
      payerTotalCents: 0,
      totalCents: 1050,
      tipsCents: 50,
      groups: [
        {
          representativeId: 'wife',
          memberIds: ['wife', 'husband', 'child'],
          grouped: true,
          totalCents: 1050,
          tipCents: 50,
        },
      ],
    });
    expect(result.groups[0]?.members).toEqual([
      { personId: 'wife', personIndex: 1, amountCents: 321, tipCents: 0 },
      { personId: 'husband', personIndex: 2, amountCents: 462, tipCents: 0 },
      { personId: 'child', personIndex: 3, amountCents: 267, tipCents: 50 },
    ]);
    expect(source).toEqual(untouched);
    expect(members).toEqual([payer, wife, husband, child]);
  });

  test('keeps solo users separate from a family, with the payer excluded', () => {
    const result = aggregateReceiptPaymentGroups(
      [payer, wife, husband, { id: 'other' }],
      0,
      [
        { personIndex: 0, total: 200, tip: 0 },
        { personIndex: 1, total: 401, tip: 10 },
        { personIndex: 2, total: 399, tip: 0 },
        { personIndex: 3, total: 120, tip: 10 },
      ],
      1100,
    );
    expect(
      result.groups.map((group) => ({
        id: group.representativeId,
        sum: group.totalCents,
        grouped: group.grouped,
      })),
    ).toEqual([
      { id: 'wife', sum: 800, grouped: true },
      { id: 'other', sum: 120, grouped: false },
    ]);
    expect(result.payerTotalCents).toBe(200);
    expect(result.totalCents).toBe(1120);
    expect(result.tipsCents).toBe(20);
  });

  test('can represent two separate families with no shared person ID', () => {
    const people = [
      payer,
      wife,
      husband,
      { id: 'rep-b', paymentGroupRepresentativeId: 'rep-b' },
      { id: 'member-b', paymentGroupRepresentativeId: 'rep-b' },
    ];
    expect(receiptPaymentMemberships(people, 0)).toEqual([
      {
        representativeId: 'wife',
        memberIds: ['wife', 'husband'],
        memberIndices: [1, 2],
        grouped: true,
      },
      {
        representativeId: 'rep-b',
        memberIds: ['rep-b', 'member-b'],
        memberIndices: [3, 4],
        grouped: true,
      },
    ]);
  });

  test('unchanged ordinary receipt produces individual payments only', () => {
    const result = aggregateReceiptPaymentGroups(
      [{ id: 'payer' }, { id: 'anna' }, { id: 'boris' }],
      0,
      [
        { personIndex: 0, total: 0, tip: 0 },
        { personIndex: 1, total: 250, tip: 0 },
        { personIndex: 2, total: 350, tip: 0 },
      ],
      600,
    );
    expect(result.groups.map((group) => [group.representativeId, group.totalCents, group.grouped])).toEqual([
      ['anna', 250, false],
      ['boris', 350, false],
    ]);
  });
});

describe('Issue 3.24.1.1: invalid composition fails closed', () => {
  test.each([
    { description: 'duplicate person ID', people: [payer, wife, wife] },
    { description: 'missing person ID', people: [payer, wife, { id: '' }] },
    { description: 'unknown representative', people: [payer, { id: 'a', paymentGroupRepresentativeId: 'absent' }] },
    {
      description: 'payer must not join groups',
      people: [{ id: 'payer', paymentGroupRepresentativeId: 'wife' }, wife, husband],
    },
    {
      description: 'payer cannot represent a group',
      people: [payer, { id: 'wife', paymentGroupRepresentativeId: 'payer' }],
    },
    { description: 'a single-person group is not a group', people: [payer, wife] },
    { description: 'representative must lead their group', people: [payer, { id: 'wife' }, husband] },
    {
      description: 'a group representative cannot simultaneously belong to another',
      people: [
        payer,
        { id: 'wife', paymentGroupRepresentativeId: 'husband' },
        { id: 'husband', paymentGroupRepresentativeId: 'wife' },
      ],
    },
  ])('rejects $description', ({ people }) => {
    expect(() => receiptPaymentMemberships(people, 0)).toThrow();
  });

  test('does not accept missing or invalid payer index', () => {
    expect(() => receiptPaymentMemberships(members, -1)).toThrow();
    expect(() => receiptPaymentMemberships(members, members.length)).toThrow();
  });

  test.each([
    {
      description: 'duplicated summary index',
      totals: [
        { personIndex: 0, total: 0, tip: 0 },
        { personIndex: 0, total: 100, tip: 0 },
      ],
    },
    {
      description: 'tip above personal due',
      totals: [
        { personIndex: 0, total: 0, tip: 0 },
        { personIndex: 1, total: 100, tip: 200 },
      ],
    },
    {
      description: 'non-integer cents',
      totals: [
        { personIndex: 0, total: 0, tip: 0 },
        { personIndex: 1, total: 100.1, tip: 0 },
      ],
    },
    {
      description: 'negative cents',
      totals: [
        { personIndex: 0, total: 0, tip: 0 },
        { personIndex: 1, total: -1, tip: 0 },
      ],
    },
  ])('rejects $description', ({ totals }) => {
    expect(() => aggregateReceiptPaymentGroups([payer, { id: 'a' }], 0, totals, 100)).toThrow();
  });

  test('rejects an amount not equal to the original bill plus individual tips', () => {
    expect(() =>
      aggregateReceiptPaymentGroups(
        [payer, { id: 'a' }],
        0,
        [
          { personIndex: 0, total: 0, tip: 0 },
          { personIndex: 1, total: 100, tip: 10 },
        ],
        100,
      ),
    ).toThrow('reconcile');
  });

  test('fails closed on unsafe integer addition', () => {
    expect(() =>
      aggregateReceiptPaymentGroups(
        [payer, { id: 'a' }, { id: 'b' }],
        0,
        [
          { personIndex: 0, total: 0, tip: 0 },
          { personIndex: 1, total: Number.MAX_SAFE_INTEGER, tip: 0 },
          { personIndex: 2, total: 1, tip: 0 },
        ],
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow();
  });
});

describe('Issue 3.24.1.2: merge, split and reassign without losing private person state', () => {
  test('supports a family, leader transfer, and ungrouping without touching dishes and tips', async () => {
    const { setReceiptPaymentGroups } = await import('./receipt-payment-groups');
    const wife = { id: 'wife', name: 'Wife', tipCents: 40, personToken: 'wife-private', personalLinkReadyAt: 'stamp' };
    const husband = { id: 'husband', name: 'Husband', tipCents: 0, personToken: 'husband-private' };
    const child = { id: 'child', name: 'Child', tipCents: 15, guestSlotNumber: 3 };
    const original = [{ id: 'payer', name: 'Payer' }, wife, husband, child];
    const mealAssignments = [
      { itemIndex: 0, personIndices: [1, 2, 3], partsByPersonId: { wife: 1, husband: 2, child: 1 } },
    ];
    const untouched = structuredClone(mealAssignments);

    const together = setReceiptPaymentGroups(original, 0, [
      { representativeId: 'wife', memberIds: ['wife', 'husband', 'child'] },
    ]);
    expect(receiptPaymentMemberships(together, 0).filter((g) => g.grouped)).toEqual([
      { representativeId: 'wife', memberIds: ['wife', 'husband', 'child'], memberIndices: [1, 2, 3], grouped: true },
    ]);
    const switched = setReceiptPaymentGroups(together, 0, [
      { representativeId: 'husband', memberIds: ['wife', 'husband', 'child'] },
    ]);
    expect(receiptPaymentMemberships(switched, 0).filter((g) => g.grouped)[0]?.representativeId).toBe('husband');
    expect(switched.map((person) => person.id)).toEqual(original.map((person) => person.id));
    expect(switched[1]).toMatchObject(wife);
    expect(switched[2]).toMatchObject(husband);
    expect(switched[3]).toMatchObject(child);
    const ungrouped = setReceiptPaymentGroups(switched, 0, []);
    expect(ungrouped.every((person) => !('paymentGroupRepresentativeId' in person))).toBe(true);
    expect(original).toEqual([{ id: 'payer', name: 'Payer' }, wife, husband, child]);
    expect(mealAssignments).toEqual(untouched);
    expect(setReceiptPaymentGroups(ungrouped, 0, [])).toEqual(ungrouped);
  });

  test.each([
    {
      description: 'repeated person within group',
      groups: [{ representativeId: 'wife', memberIds: ['wife', 'wife'] }],
    },
    {
      description: 'overlap across groups',
      groups: [
        { representativeId: 'wife', memberIds: ['wife', 'husband'] },
        { representativeId: 'husband', memberIds: ['husband', 'child'] },
      ],
    },
    { description: 'nonexistent member', groups: [{ representativeId: 'wife', memberIds: ['wife', 'stranger'] }] },
    {
      description: 'representative is missing from members',
      groups: [{ representativeId: 'wife', memberIds: ['husband', 'child'] }],
    },
    { description: 'payer in payment group', groups: [{ representativeId: 'wife', memberIds: ['wife', 'payer'] }] },
    { description: 'only one member', groups: [{ representativeId: 'wife', memberIds: ['wife'] }] },
  ])('rejects $description atomically', async ({ groups }) => {
    const { setReceiptPaymentGroups } = await import('./receipt-payment-groups');
    const original = structuredClone(members);
    expect(() => setReceiptPaymentGroups(members, 0, groups)).toThrow();
    expect(members).toEqual(original);
  });
});
