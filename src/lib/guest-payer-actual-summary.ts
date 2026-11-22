import { MAX_MONEY_CENTS } from './money';
import type { ReceiptOverpaymentChoice } from './actual-receipt-payments';

/** Private, payer-only bank attestation snapshot. Never publish with guest.getSession. */
export type PayerActualRow = {
  personId: string;
  amount: number;
  receivedCents: number;
  appliedToDebtCents: number;
  outstandingCents: number;
  excessCents: number;
  extraTipCents: number;
  refundDueCents: number;
  refundedCents: number;
  pendingExcessCents: number;
  overpaymentChoice: ReceiptOverpaymentChoice | null;
};

export type PayerActualTotals = {
  expected: number;
  received: number;
  credited: number;
  extraTips: number;
  toRefund: number;
  refunded: number;
  undecided: number;
  remaining: number;
};

const valid = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MONEY_CENTS;

/** One transfer kopeck is either debt, chosen waiter tip, refunded,
 * awaiting refund, or undecided. No legacy sender declaration enters here.
 * Fail closed if any incoming row doesn't reconcile.
 */
export function summarizePayerActualReceipts(
  rows: readonly PayerActualRow[],
  payerPersonId: string,
): PayerActualTotals | null {
  const totals: PayerActualTotals = {
    expected: 0,
    received: 0,
    credited: 0,
    extraTips: 0,
    toRefund: 0,
    refunded: 0,
    undecided: 0,
    remaining: 0,
  };
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.personId || row.personId === payerPersonId || seen.has(row.personId)) return null;
    seen.add(row.personId);
    const money = [
      row.amount,
      row.receivedCents,
      row.appliedToDebtCents,
      row.outstandingCents,
      row.excessCents,
      row.extraTipCents,
      row.refundDueCents,
      row.refundedCents,
      row.pendingExcessCents,
    ];
    if (!money.every(valid)) return null;
    const credited = Math.min(row.amount, row.receivedCents);
    const excess = row.receivedCents - credited;
    if (
      row.appliedToDebtCents !== credited ||
      row.outstandingCents !== row.amount - credited ||
      row.excessCents !== excess
    )
      return null;
    const expectedDistribution =
      row.overpaymentChoice === 'tip'
        ? [excess, 0, 0, 0]
        : row.overpaymentChoice === 'refund'
          ? [0, excess - row.refundedCents, row.refundedCents, 0]
          : row.overpaymentChoice === null
            ? [0, 0, 0, excess]
            : null;
    if (
      !expectedDistribution ||
      expectedDistribution.some((n) => n < 0) ||
      [row.extraTipCents, row.refundDueCents, row.refundedCents, row.pendingExcessCents].some(
        (n, i) => n !== expectedDistribution[i],
      )
    )
      return null;
    const fields: (keyof PayerActualTotals)[] = [
      'expected',
      'received',
      'credited',
      'extraTips',
      'toRefund',
      'refunded',
      'undecided',
      'remaining',
    ];
    const values = [
      row.amount,
      row.receivedCents,
      credited,
      row.extraTipCents,
      row.refundDueCents,
      row.refundedCents,
      row.pendingExcessCents,
      row.outstandingCents,
    ];
    fields.forEach((field, i) => {
      totals[field] += values[i]!;
    });
    if (!fields.every((field) => valid(totals[field]))) return null;
  }
  if (
    totals.received !== totals.credited + totals.extraTips + totals.toRefund + totals.refunded + totals.undecided ||
    totals.expected !== totals.credited + totals.remaining
  )
    return null;
  return totals;
}

/** Live payer overview = immutable original restaurant amount + verified extra tips.
 * The original personal tips are already included in the finalized receipt sum.
 */
export function combinedWaiterTotals(
  foodCents: number,
  personalTipCents: number,
  actual: PayerActualTotals | null,
): { tipCents: number; totalCents: number } | null {
  if (!actual || !valid(foodCents) || !valid(personalTipCents)) return null;
  const tipCents = personalTipCents + actual.extraTips;
  const totalCents = foodCents + tipCents;
  return valid(tipCents) && valid(totalCents) ? { tipCents, totalCents } : null;
}
