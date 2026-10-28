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
      shares: [
        { userId: 'alice', amount: 650 },
        { userId: 'bob', amount: 501 },
      ],
    },
  };
  test('one payer sees original dish bill, total waiter tips and reconciled expense', () => {
    expect(manualExpenseBreakdown(fixture)).toEqual({ foodTotal: 1001, tipTotal: 150, total: 1151 });
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
    ).toEqual({ foodTotal: 1001, tipTotal: 0, total: 1001 });
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
