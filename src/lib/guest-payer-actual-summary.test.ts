import { describe, expect, it } from 'vitest';
import { reconcileActualReceiptTransfers, type ReceiptOverpaymentChoice } from './actual-receipt-payments';
import { summarizePayerActualReceipts, combinedWaiterTotals, type PayerActualRow } from './guest-payer-actual-summary';

const id = (index: number) => String(index).padStart(3, '0');
const makeRow = (
  personId: string,
  expected: number,
  declaredTips: number,
  received: number,
  choice: ReceiptOverpaymentChoice | null = null,
  refunded = 0,
): PayerActualRow => ({
  personId,
  amount: expected,
  overpaymentChoice: choice,
  ...reconcileActualReceiptTransfers(
    expected,
    declaredTips,
    received
      ? [{ id: id(1), amountCents: received, confirmedAt: '2026-11-22T10:00:00Z', confirmedByPersonId: 'payer' }]
      : [],
    choice,
    refunded
      ? [{ id: id(2), amountCents: refunded, confirmedAt: '2026-11-22T11:00:00Z', confirmedByPersonId: 'payer' }]
      : [],
  ),
});
const totals = (rows: PayerActualRow[]) => summarizePayerActualReceipts(rows, 'payer');

describe('Issue #19 12.1–12.3: combined waiter tips without touching original debts', () => {
  it('reproduces 1265 food, 965 debt, 1000 incoming and 35 extra waiter tips', () => {
    const row = makeRow('andrey', 96500, 0, 100000, 'tip');
    const got = totals([row]);
    expect(got).toEqual({
      expected: 96500,
      received: 100000,
      credited: 96500,
      extraTips: 3500,
      toRefund: 0,
      refunded: 0,
      undecided: 0,
      remaining: 0,
    });
    expect(combinedWaiterTotals(126500, 0, got)).toEqual({ tipCents: 3500, totalCents: 130000 });
    expect(row.amount).toBe(96500);
  });
  it('adds declared waiter tips and all later overpayments exactly once', () => {
    const a = makeRow('andrey', 96500, 1500, 100000, 'tip');
    const b = makeRow('boris', 12000, 200, 13000, 'tip');
    const got = totals([a, b]);
    expect(got?.extraTips).toBe(4500);
    expect(combinedWaiterTotals(126500, 1700, got)).toEqual({ tipCents: 6200, totalCents: 132700 });
    expect(got?.expected).toBe(108500);
  });
  it('does not count undecided, refundable or refunded excess as tips', () => {
    const pending = totals([makeRow('a', 96500, 0, 100000)]);
    expect(pending?.undecided).toBe(3500);
    expect(pending?.extraTips).toBe(0);
    const refund = totals([makeRow('a', 96500, 0, 100000, 'refund', 1000)]);
    expect(refund).toMatchObject({ extraTips: 0, toRefund: 2500, refunded: 1000, credited: 96500 });
    expect(combinedWaiterTotals(126500, 0, refund)).toEqual({ tipCents: 0, totalCents: 126500 });
  });
  it('recomputes after an immutable correction, then cancelled receipt or partial payment', () => {
    expect(totals([makeRow('a', 96500, 0, 100000, 'tip')])?.extraTips).toBe(3500);
    expect(totals([makeRow('a', 96500, 0, 100500, 'tip')])?.extraTips).toBe(4000);
    expect(totals([makeRow('a', 96500, 0, 0, 'tip')])).toMatchObject({
      extraTips: 0,
      credited: 0,
      remaining: 96500,
      received: 0,
    });
    expect(totals([makeRow('a', 96500, 0, 60000)])).toMatchObject({
      extraTips: 0,
      credited: 60000,
      remaining: 36500,
    });
  });
  it('counts grouped transfer only once per representative, not once per family member', () => {
    const wife = makeRow('wife', 13000, 500, 15000, 'tip');
    expect(totals([wife])).toMatchObject({ expected: 13000, credited: 13000, extraTips: 2000 });
    expect(totals([wife, wife])).toBeNull();
    expect(totals([{ ...wife, personId: 'payer' }])).toBeNull();
  });
  it('rejects malformed and inconsistent payer snapshots rather than showing false final money', () => {
    const a = makeRow('a', 96500, 0, 100000, 'tip');
    expect(totals([{ ...a, extraTipCents: 7000 }])).toBeNull();
    expect(totals([{ ...a, receivedCents: NaN }])).toBeNull();
    expect(totals([{ ...a, appliedToDebtCents: 100000 }])).toBeNull();
    expect(totals([{ ...a, overpaymentChoice: null }])).toBeNull();
    expect(totals([{ ...a, overpaymentChoice: 'refund' }])).toBeNull();
    expect(totals([{ ...a, refundedCents: 1 }])).toBeNull();
    expect(combinedWaiterTotals(126500, 0, null)).toBeNull();
    expect(combinedWaiterTotals(2147483647, 100, totals([a]))).toBeNull();
  });
  it('does not miscount repeated server reads or exchange any receipt money with the user', () => {
    const a = makeRow('a', 96500, 0, 100000, 'tip');
    expect(totals([a])).toEqual(totals([{ ...a }]));
    expect(a.amount).toBe(96500);
  });
});
