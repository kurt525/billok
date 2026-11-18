import { describe, expect, it } from 'vitest';
import {
  parseExactReceivedRub,
  reconcileActualReceiptTransfers,
  type ActualReceiptTransfer,
} from './actual-receipt-payments';
import { MAX_MONEY_CENTS } from './money';

const transfer = (amountCents: number, id = 't1'): ActualReceiptTransfer => ({
  id,
  amountCents,
  confirmedAt: '2026-11-18T10:00:00.000Z',
  confirmedByPersonId: 'payer-id',
});

describe('5.22: payer-attested RUB input', () => {
  it.each([
    ['1450', 145000],
    ['1 450,50', 145050],
    ['1\\u00a0450,5', 145050],
    ['1\\u202f450.05', 145005],
    ['0,01', 1],
    ['21474836,47', MAX_MONEY_CENTS],
  ])('%s -> exactly %d kopecks', (rub, kopecks) => {
    expect(parseExactReceivedRub(rub.replace('\\u00a0', '\u00a0').replace('\\u202f', '\u202f'))).toBe(kopecks);
  });

  it.each(['', '0', '0,00', '-1', '1,234', '1.000.50', '1e3', 'abc', '21474836,48', '999999999999'])(
    'rejects non-positive, ambiguous, rounded or out-of-range input: %s',
    (input) => expect(parseExactReceivedRub(input)).toBeNull(),
  );
});

describe('5.22: immutable dish debt, separate additional tips and refunds', () => {
  it('keeps an original 1200 RUB dish and 100 RUB declared tip, adds 150 RUB once', () => {
    const result = reconcileActualReceiptTransfers(130000, 10000, [transfer(145000)], 'tip');
    expect(result).toEqual({
      expectedCents: 130000,
      foodCents: 120000,
      declaredTipCents: 10000,
      receivedCents: 145000,
      appliedToDebtCents: 130000,
      outstandingCents: 0,
      excessCents: 15000,
      extraTipCents: 15000,
      refundDueCents: 0,
      pendingExcessCents: 0,
    });
  });

  it('treats excess as refundable, not additional tips, when payer chooses refund', () => {
    const x = reconcileActualReceiptTransfers(130000, 10000, [transfer(145000)], 'refund');
    expect([x.extraTipCents, x.refundDueCents]).toEqual([0, 15000]);
  });

  it('does not silently classify undecided overpayment', () => {
    const x = reconcileActualReceiptTransfers(130000, 10000, [transfer(145000)]);
    expect([x.extraTipCents, x.refundDueCents, x.pendingExcessCents]).toEqual([0, 0, 15000]);
  });

  it('tracks a partial payment and exact remaining debt', () => {
    const x = reconcileActualReceiptTransfers(130000, 10000, [transfer(50000)]);
    expect([x.appliedToDebtCents, x.outstandingCents, x.extraTipCents]).toEqual([50000, 80000, 0]);
  });

  it('combines two payments without assuming an extra second debt', () => {
    const x = reconcileActualReceiptTransfers(130000, 10000, [transfer(50000), transfer(95000, 't2')], 'tip');
    expect([x.receivedCents, x.appliedToDebtCents, x.outstandingCents, x.extraTipCents]).toEqual([
      145000, 130000, 0, 15000,
    ]);
  });

  it('excludes cancelled receipts while retaining them for audit', () => {
    const cancelled = { ...transfer(50000), cancelledAt: '2026-11-18T11:00:00.000Z' };
    const x = reconcileActualReceiptTransfers(130000, 10000, [cancelled, transfer(95000, 't2')]);
    expect([x.receivedCents, x.outstandingCents]).toEqual([95000, 35000]);
  });

  it('never counts the same receipt ID twice', () => {
    expect(() => reconcileActualReceiptTransfers(130000, 10000, [transfer(50000), transfer(95000)])).toThrow();
  });

  it('rejects invalid costs, tips and forged or unbounded transfers', () => {
    expect(() => reconcileActualReceiptTransfers(100, 101, [])).toThrow();
    expect(() => reconcileActualReceiptTransfers(-1, 0, [])).toThrow();
    expect(() => reconcileActualReceiptTransfers(100, 0, [transfer(-1)])).toThrow();
    expect(() => reconcileActualReceiptTransfers(100, 0, [transfer(MAX_MONEY_CENTS), transfer(1, 't2')])).toThrow();
  });

  it('keeps a grouped transfer as one debt, with members separate outside the ledger', () => {
    const group = reconcileActualReceiptTransfers(20000, 1000, [transfer(21000)], 'tip');
    expect([group.foodCents, group.declaredTipCents, group.extraTipCents]).toEqual([19000, 1000, 1000]);
  });
});
