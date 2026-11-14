import { describe, expect, it } from 'vitest';
import { groupGuestPayerPayments } from './guest-payer-payment-groups';
import { summarizeGuestPayerPaymentGroups } from './guest-payer-payment-summary';

const payer = { personId: 'payer', amount: 334, declaredPaidAt: null, verifiedAt: null };
const anna = { personId: 'anna', amount: 459, declaredPaidAt: null, verifiedAt: null };
const victor = { personId: 'victor', amount: 408, declaredPaidAt: null, verifiedAt: null };

type PaymentFixture = {
  personId: string;
  amount: number;
  declaredPaidAt: string | null;
  verifiedAt: string | null;
};

const summarize = (rows: readonly PaymentFixture[]) =>
  summarizeGuestPayerPaymentGroups(groupGuestPayerPayments(rows, payer.personId));

describe('Issue #1 5.7: exact private payer receipt summary in kopecks', () => {
  it('excludes the payer own share and starts with all other debts unpaid', () => {
    expect(summarize([payer, anna, victor])).toEqual({
      total: 867,
      verified: 0,
      awaiting: 0,
      unpaid: 867,
      outstanding: 867,
    });
  });

  it('moves a declaration to awaiting without changing overall amount', () => {
    const marked = { ...anna, declaredPaidAt: '2026-11-09T15:00:00.000Z' };
    expect(summarize([payer, marked, victor])).toEqual({
      total: 867,
      verified: 0,
      awaiting: 459,
      unpaid: 408,
      outstanding: 867,
    });
  });

  it('moves confirmed receipts to verified and subtracts only those from outstanding', () => {
    const confirmed = {
      ...anna,
      declaredPaidAt: '2026-11-09T15:00:00.000Z',
      verifiedAt: '2026-11-09T15:01:00.000Z',
    };
    expect(summarize([payer, confirmed, victor])).toEqual({
      total: 867,
      verified: 459,
      awaiting: 0,
      unpaid: 408,
      outstanding: 408,
    });
    const both = { ...victor, declaredPaidAt: confirmed.declaredPaidAt, verifiedAt: confirmed.verifiedAt };
    expect(summarize([payer, confirmed, both])).toEqual({
      total: 867,
      verified: 867,
      awaiting: 0,
      unpaid: 0,
      outstanding: 0,
    });
  });

  it('cancellation returns exactly the same kopecks to unpaid, including tips', () => {
    const marked = { ...anna, declaredPaidAt: '2026-11-09T15:00:00.000Z' };
    expect(summarize([payer, marked, victor])?.awaiting).toBe(459);
    expect(summarize([payer, anna, victor])?.unpaid).toBe(867);
  });

  it('counts one family representative only once, not each family member', () => {
    const family = {
      personId: 'wife',
      amount: 951,
      memberIds: ['wife', 'husband', 'child'],
      declaredPaidAt: '2026-11-09T15:00:00.000Z',
      verifiedAt: null,
    };
    expect(summarizeGuestPayerPaymentGroups(groupGuestPayerPayments([payer, family, victor], 'payer'))).toEqual({
      total: 1359,
      verified: 0,
      awaiting: 951,
      unpaid: 408,
      outstanding: 1359,
    });
  });

  it('keeps all five totals at zero if no participant owes the payer', () => {
    expect(summarize([payer])).toEqual({
      total: 0,
      verified: 0,
      awaiting: 0,
      unpaid: 0,
      outstanding: 0,
    });
  });

  it('rejects non-integer, negative and unsafe sums, rather than showing fabricated money', () => {
    for (const amount of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(summarize([{ ...anna, amount }])).toBeNull();
    }
    expect(
      summarize([
        { ...anna, amount: Number.MAX_SAFE_INTEGER },
        { ...victor, amount: 1 },
      ]),
    ).toBeNull();
  });

  it('preserves the kopeck reconciliation identity across payment state combinations', () => {
    const statuses = [
      { declaredPaidAt: null, verifiedAt: null },
      { declaredPaidAt: '2026-11-09T15:00:00.000Z', verifiedAt: null },
      { declaredPaidAt: '2026-11-09T15:00:00.000Z', verifiedAt: '2026-11-09T15:01:00.000Z' },
    ];
    for (const first of statuses) {
      for (const second of statuses) {
        const summary = summarize([payer, { ...anna, ...first }, { ...victor, ...second }]);
        expect(summary).not.toBeNull();
        expect(summary!.total).toBe(867);
        expect(summary!.verified + summary!.awaiting + summary!.unpaid).toBe(summary!.total);
        expect(summary!.awaiting + summary!.unpaid).toBe(summary!.outstanding);
      }
    }
  });
});
