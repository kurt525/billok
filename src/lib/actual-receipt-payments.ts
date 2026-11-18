import { MAX_MONEY_CENTS } from './money';

/** 5.22: payer-attested incoming transfers; never treat a sender's declaration as bank evidence. */
export type ReceiptOverpaymentChoice = 'tip' | 'refund';

export type ActualReceiptTransfer = {
  id: string;
  amountCents: number;
  confirmedAt: string;
  confirmedByPersonId: string;
  cancelledAt?: string;
  cancelledByPersonId?: string;
};

export type ActualReceiptReconciliation = {
  expectedCents: number;
  foodCents: number;
  declaredTipCents: number;
  receivedCents: number;
  appliedToDebtCents: number;
  outstandingCents: number;
  excessCents: number;
  extraTipCents: number;
  refundDueCents: number;
  pendingExcessCents: number;
};

function safeCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MONEY_CENTS;
}

/** Convert typed RUB into EXACT kopecks. Never silently round 3+ decimal places. */
export function parseExactReceivedRub(input: string): number | null {
  const normalized = input
    .trim()
    .replace(/[ \u00a0\u202f]/g, '')
    .replace(',', '.');
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [rub, kopecks = ''] = normalized.split('.');
  const value = Number(rub) * 100 + Number(kopecks.padEnd(2, '0'));
  return safeCents(value) && value > 0 ? value : null;
}

/** Reconcile distinct transfers for ONE finalized receipt debtor / group representative.
 * Original dishes, declared tips and the immutable settlement lock are never altered.
 * An undecided excess is not secretly treated as tips or a refund.
 */
export function reconcileActualReceiptTransfers(
  expectedCents: number,
  declaredTipCents: number,
  transfers: readonly ActualReceiptTransfer[],
  choice: ReceiptOverpaymentChoice | null = null,
): ActualReceiptReconciliation {
  if (!safeCents(expectedCents) || !safeCents(declaredTipCents) || declaredTipCents > expectedCents) {
    throw new Error('Invalid finalized payment amount or declared tips');
  }
  if (choice !== null && choice !== 'tip' && choice !== 'refund') {
    throw new Error('Invalid excess payment disposition');
  }
  let receivedCents = 0;
  const ids = new Set<string>();
  for (const entry of transfers) {
    if (
      typeof entry.id !== 'string' ||
      !entry.id ||
      ids.has(entry.id) ||
      !safeCents(entry.amountCents) ||
      entry.amountCents <= 0 ||
      typeof entry.confirmedAt !== 'string' ||
      !entry.confirmedAt ||
      typeof entry.confirmedByPersonId !== 'string' ||
      !entry.confirmedByPersonId
    ) {
      throw new Error('Invalid or duplicated incoming payment');
    }
    ids.add(entry.id);
    if (entry.cancelledAt) continue;
    receivedCents += entry.amountCents;
    if (!safeCents(receivedCents)) throw new Error('Incoming amount exceeds monetary limit');
  }
  const appliedToDebtCents = Math.min(expectedCents, receivedCents);
  const outstandingCents = expectedCents - appliedToDebtCents;
  const excessCents = receivedCents - appliedToDebtCents;
  return {
    expectedCents,
    foodCents: expectedCents - declaredTipCents,
    declaredTipCents,
    receivedCents,
    appliedToDebtCents,
    outstandingCents,
    excessCents,
    extraTipCents: choice === 'tip' ? excessCents : 0,
    refundDueCents: choice === 'refund' ? excessCents : 0,
    pendingExcessCents: choice === null ? excessCents : 0,
  };
}
