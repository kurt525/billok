/** Categorize only the payer's incoming obligations, without computing financial summary totals (Issue 5.7). */
export type GuestPayerPaymentRow = {
  personId: string;
  declaredPaidAt: string | null;
  verifiedAt: string | null;
};

export type GuestPayerPaymentGroup = 'verified' | 'awaiting' | 'unpaid';

/** The server's private payer review already collapses a family group into one transfer.
 * The extra own-ID filter protects the UI if an upstream response ever includes the payer.
 */
export function groupGuestPayerPayments<T extends GuestPayerPaymentRow>(
  payments: readonly T[],
  payerPersonId: string,
): Record<GuestPayerPaymentGroup, T[]> {
  const groups: Record<GuestPayerPaymentGroup, T[]> = { verified: [], awaiting: [], unpaid: [] };
  for (const payment of payments) {
    if (payment.personId === payerPersonId) continue;
    if (payment.declaredPaidAt && payment.verifiedAt) groups.verified.push(payment);
    else if (payment.declaredPaidAt) groups.awaiting.push(payment);
    else groups.unpaid.push(payment);
  }
  return groups;
}
