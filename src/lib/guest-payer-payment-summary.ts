import type { GuestPayerPaymentGroup } from './guest-payer-payment-groups';

/** Issue #1 5.7: exact integer-kopeck totals for one payer's private, finalized receipt.
 * The caller first groups the server's unique reimbursement rows, excluding the payer.
 * No bank payments, arbitrary inputs or other receipts enter these calculations.
 */
export type GuestPayerPaymentSummary = {
  total: number;
  verified: number;
  awaiting: number;
  unpaid: number;
  outstanding: number;
};

/** Return null instead of showing misleading figures if an invalid amount reaches the client. */
export function summarizeGuestPayerPaymentGroups<T extends { amount: number }>(
  groups: Record<GuestPayerPaymentGroup, readonly T[]>,
): GuestPayerPaymentSummary | null {
  const sum = (rows: readonly T[]): number | null => {
    let total = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.amount) || row.amount < 0) return null;
      total += row.amount;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  };
  const verified = sum(groups.verified);
  const awaiting = sum(groups.awaiting);
  const unpaid = sum(groups.unpaid);
  if (verified === null || awaiting === null || unpaid === null) return null;
  const outstanding = awaiting + unpaid;
  const total = verified + outstanding;
  if (!Number.isSafeInteger(outstanding) || !Number.isSafeInteger(total)) return null;
  // By construction: total = verified + awaiting + unpaid in exact integer kopecks.
  return { total, verified, awaiting, unpaid, outstanding };
}
