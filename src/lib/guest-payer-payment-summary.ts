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
export function summarizeGuestPayerPaymentGroups<
  T extends { amount: number; receivedCents?: number; verifiedAt?: string | null; declaredPaidAt?: string | null },
>(groups: Record<GuestPayerPaymentGroup, readonly T[]>): GuestPayerPaymentSummary | null {
  let verified = 0;
  let awaiting = 0;
  let unpaid = 0;
  for (const row of [...groups.verified, ...groups.awaiting, ...groups.unpaid]) {
    if (!Number.isSafeInteger(row.amount) || row.amount < 0) return null;
    const received = row.receivedCents ?? (row.verifiedAt ? row.amount : 0);
    if (!Number.isSafeInteger(received) || received < 0) return null;
    const credited = Math.min(row.amount, received);
    const remaining = row.amount - credited;
    verified += credited;
    if (row.declaredPaidAt || received > 0) awaiting += remaining;
    else unpaid += remaining;
    if (![verified, awaiting, unpaid].every(Number.isSafeInteger)) return null;
  }
  const outstanding = awaiting + unpaid;
  const total = verified + outstanding;
  if (!Number.isSafeInteger(outstanding) || !Number.isSafeInteger(total)) return null;
  return { total, verified, awaiting, unpaid, outstanding };
}
