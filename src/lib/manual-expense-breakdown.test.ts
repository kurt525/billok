import { describe, expect, test } from 'vitest';
import { manualExpenseBreakdown } from './manual-expense-breakdown';

describe('manual group receipt: final waiter tip reconciliation', () => {
  const fixture = {
    receipt: {
      creatorId: 'bob',
      extractedData: { currency: 'RUB', tax: 0, tip: 0, personalTips: { alice: 150, bob: 0 } },
    },
    items: [
      {
        id: 'pizza',
        totalPrice: 1001,
        assignments: [
          { userId: 'alice', shareOfItem: 1 },
          { userId: 'bob', shareOfItem: 1 },
        ],
      },
    ],
    expense: {
      amount: 1151,
      currency: 'RUB',
      paidById: 'bob',
      shares: [
        { userId: 'alice', amount: 650 },
        { userId: 'bob', amount: 501 },
      ],
    },
  };
  test('one payer sees original dish bill, total waiter tips and reconciled expense', () => {
    expect(manualExpenseBreakdown(fixture)).toEqual({
      foodTotal: 1001,
      tipTotal: 150,
      total: 1151,
      payerShare: 501,
      reimbursementTotal: 650,
      reimbursements: [{ fromId: 'alice', amount: 650 }],
      organizerCorrection: { userId: 'bob', amount: 1 },
    });
    expect(manualExpenseBreakdown(fixture)?.foodTotal).toBe(1001);
  });
  test('0 RUB personal tips are valid and do not create mandatory charges', () => {
    expect(
      manualExpenseBreakdown({
        ...fixture,
        receipt: { ...fixture.receipt, extractedData: { ...fixture.receipt.extractedData, personalTips: {} } },
        expense: {
          ...fixture.expense,
          amount: 1001,
          shares: [
            { userId: 'alice', amount: 500 },
            { userId: 'bob', amount: 501 },
          ],
        },
      }),
    ).toEqual({
      foodTotal: 1001,
      tipTotal: 0,
      total: 1001,
      payerShare: 501,
      reimbursementTotal: 500,
      reimbursements: [{ fromId: 'alice', amount: 500 }],
      organizerCorrection: { userId: 'bob', amount: 1 },
    });
  });
  test('rounding always belongs to creator, not an arbitrarily selected payer', () => {
    expect(manualExpenseBreakdown(fixture)).not.toBeNull();
    expect(
      manualExpenseBreakdown({
        ...fixture,
        expense: {
          ...fixture.expense,
          shares: [
            { userId: 'alice', amount: 651 },
            { userId: 'bob', amount: 500 },
          ],
        },
      }),
    ).toBeNull();
  });
  test('refuses to show an irreconcilable or forged monetary summary', () => {
    expect(manualExpenseBreakdown({ ...fixture, expense: { ...fixture.expense, amount: 1152 } })).toBeNull();
    expect(
      manualExpenseBreakdown({
        ...fixture,
        receipt: {
          ...fixture.receipt,
          extractedData: { ...fixture.receipt.extractedData, personalTips: { bob: 150 } },
        },
      }),
    ).toBeNull();
    expect(
      manualExpenseBreakdown({
        ...fixture,
        receipt: { ...fixture.receipt, extractedData: { ...fixture.receipt.extractedData, tax: 1 } },
      }),
    ).toBeNull();
    expect(
      manualExpenseBreakdown({
        ...fixture,
        receipt: {
          ...fixture.receipt,
          extractedData: { ...fixture.receipt.extractedData, personalTips: { nobody: 1 } },
        },
      }),
    ).toBeNull();
  });
  test('fails closed for receipt items with no assigned participants', () => {
    expect(
      manualExpenseBreakdown({ ...fixture, items: [{ id: 'pizza', totalPrice: 1001, assignments: [] }] }),
    ).toBeNull();
  });
  test('rejects expense shares that do not reconcile with saved personal tips', () => {
    expect(
      manualExpenseBreakdown({
        ...fixture,
        expense: {
          ...fixture.expense,
          shares: [
            { userId: 'alice', amount: 651 },
            { userId: 'bob', amount: 500 },
          ],
        },
      }),
    ).toBeNull();
  });
});

describe('Issue 2.17.1: separate rounding adjustment without a fictitious eaten dish', () => {
  const input = {
    receipt: { creatorId: 'host', extractedData: { currency: 'RUB', tax: 0, tip: 0 } },
    items: [
      {
        id: 'dish',
        totalPrice: 101,
        assignments: [
          { userId: 'alice', shareOfItem: 3 },
          { userId: 'bob', shareOfItem: 5 },
        ],
      },
    ],
    expense: {
      amount: 101,
      currency: 'RUB',
      paidById: 'alice',
      shares: [
        { userId: 'alice', amount: 37 },
        { userId: 'bob', amount: 63 },
        { userId: 'host', amount: 1 },
      ],
    },
  };

  test('rounding correction belongs to receipt creator, not the selected payer or dish consumers', () => {
    const result = manualExpenseBreakdown(input);
    expect(result).toMatchObject({
      foodTotal: 101,
      tipTotal: 0,
      total: 101,
      organizerCorrection: { userId: 'host', amount: 1 },
      payerShare: 37,
      reimbursementTotal: 64,
      reimbursements: [
        { fromId: 'bob', amount: 63 },
        { fromId: 'host', amount: 1 },
      ],
    });
    expect(input.items[0]!.assignments.map((part) => part.userId)).toEqual(['alice', 'bob']);
  });

  test('if the organizer also paid, there is no transfer to themselves', () => {
    const result = manualExpenseBreakdown({ ...input, expense: { ...input.expense, paidById: 'host' } });
    expect(result).toMatchObject({
      organizerCorrection: { userId: 'host', amount: 1 },
      payerShare: 1,
      reimbursementTotal: 100,
      reimbursements: [
        { fromId: 'alice', amount: 37 },
        { fromId: 'bob', amount: 63 },
      ],
    });
    expect(result?.reimbursements.every((row) => row.fromId !== 'host')).toBe(true);
  });
});

describe('Issue 2.17.2: two-dish unavoidable rounding is visible only as creator adjustment', () => {
  const data = {
    receipt: { creatorId: 'host', extractedData: { currency: 'RUB', tax: 0, tip: 0 } },
    items: [
      {
        id: 'dish',
        totalPrice: 1,
        assignments: [
          { userId: 'alice', shareOfItem: 1 },
          { userId: 'bob', shareOfItem: 1 },
          { userId: 'carol', shareOfItem: 1 },
        ],
      },
      { id: 'drink', totalPrice: 1, assignments: [{ userId: 'dave', shareOfItem: 1 }] },
    ],
    expense: {
      amount: 2,
      currency: 'RUB',
      paidById: 'dave',
      shares: [
        { userId: 'alice', amount: 0 },
        { userId: 'bob', amount: 0 },
        { userId: 'carol', amount: 0 },
        { userId: 'dave', amount: 1 },
        { userId: 'host', amount: 1 },
      ],
    },
  };

  test('the exact saved amount includes one explicit organizer correction, without claiming any dish', () => {
    const result = manualExpenseBreakdown(data);
    expect(result).toMatchObject({
      foodTotal: 2,
      tipTotal: 0,
      total: 2,
      organizerCorrection: { userId: 'host', amount: 1 },
      payerShare: 1,
      reimbursementTotal: 1,
      reimbursements: [{ fromId: 'host', amount: 1 }],
    });
    expect(data.items.flatMap((item) => item.assignments).every((a) => a.userId !== 'host')).toBe(true);
  });

  test('the organizer paying the bill does not reimburse themself', () => {
    const result = manualExpenseBreakdown({ ...data, expense: { ...data.expense, paidById: 'host' } });
    expect(result).toMatchObject({
      organizerCorrection: { userId: 'host', amount: 1 },
      payerShare: 1,
      reimbursementTotal: 1,
      reimbursements: [{ fromId: 'dave', amount: 1 }],
    });
  });
});

describe('per-receipt reimbursement excludes sole payer and includes each chosen tip', () => {
  const base = {
    receipt: {
      creatorId: 'alice',
      extractedData: {
        currency: 'RUB',
        tax: 0,
        tip: 0,
        personalTips: { alice: 50, bob: 25, charlie: 0 },
      },
    },
    items: [
      {
        id: 'dinner',
        totalPrice: 300,
        assignments: [
          { userId: 'alice', shareOfItem: 1 },
          { userId: 'bob', shareOfItem: 1 },
          { userId: 'charlie', shareOfItem: 1 },
        ],
      },
    ],
    expense: {
      amount: 375,
      currency: 'RUB',
      paidById: 'alice',
      shares: [
        { userId: 'alice', amount: 150 },
        { userId: 'bob', amount: 125 },
        { userId: 'charlie', amount: 100 },
      ],
    },
  };
  test('one payer covers their own food plus tip; only others reimburse', () => {
    const result = manualExpenseBreakdown(base);
    expect(result).toMatchObject({
      foodTotal: 300,
      tipTotal: 75,
      total: 375,
      payerShare: 150,
      reimbursementTotal: 225,
      reimbursements: [
        { fromId: 'bob', amount: 125 },
        { fromId: 'charlie', amount: 100 },
      ],
    });
    expect(result!.reimbursements.every((payment) => payment.fromId !== base.expense.paidById)).toBe(true);
  });
  test('choosing a different payer does not redistribute any tips', () => {
    const result = manualExpenseBreakdown({ ...base, expense: { ...base.expense, paidById: 'bob' } });
    expect(result).toMatchObject({
      total: 375,
      payerShare: 125,
      reimbursementTotal: 250,
      reimbursements: [
        { fromId: 'alice', amount: 150 },
        { fromId: 'charlie', amount: 100 },
      ],
    });
  });
  test('a sole payer who consumed nothing owes no share to themselves', () => {
    expect(manualExpenseBreakdown({ ...base, expense: { ...base.expense, paidById: 'payer' } })).toMatchObject({
      payerShare: 0,
      reimbursementTotal: 375,
      reimbursements: [
        { fromId: 'alice', amount: 150 },
        { fromId: 'bob', amount: 125 },
        { fromId: 'charlie', amount: 100 },
      ],
    });
  });
  test('one diner paid all and thus has no reimbursement to themselves', () => {
    const single = {
      receipt: { creatorId: 'alice', extractedData: { currency: 'RUB', tax: 0, tip: 0, personalTips: { alice: 50 } } },
      items: [{ id: 'dinner', totalPrice: 100, assignments: [{ userId: 'alice', shareOfItem: 1 }] }],
      expense: { amount: 150, currency: 'RUB', paidById: 'alice', shares: [{ userId: 'alice', amount: 150 }] },
    };
    expect(manualExpenseBreakdown(single)).toMatchObject({
      payerShare: 150,
      reimbursementTotal: 0,
      reimbursements: [],
    });
  });
});
