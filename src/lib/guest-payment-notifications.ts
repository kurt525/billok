/** UI-only change detection for private guest payment polling.
 * No payment status is inferred from a notification.
 */
export type GuestPaymentNoticeRow = {
  personId: string;
  declaredPaidAt: string | null;
  verifiedAt: string | null;
};

export function mergeGuestPaymentStatuses<T extends GuestPaymentNoticeRow>(
  previous: readonly T[] | null,
  incoming: readonly T[],
): T[] {
  // Callers discard out-of-order read responses. Null from the newest server
  // snapshot must clear a cancelled declaration, not resurrect an old status.
  void previous;
  return incoming.map((row) => ({ ...row }));
}

/** First successful poll establishes a baseline; do not notify on page reload. */
export function newlyDeclaredGuestPayments<T extends GuestPaymentNoticeRow>(
  previous: readonly T[] | null,
  incoming: readonly T[],
): T[] {
  if (previous === null) return [];
  return incoming.filter(
    (row) =>
      row.declaredPaidAt !== null &&
      previous.some((person) => person.personId === row.personId && !person.declaredPaidAt),
  );
}

/** undefined means first successful private read, null means previously unverified. */
export function becameVerified(previous: string | null | undefined, incoming: string | null): boolean {
  return previous === null && incoming !== null;
}

/** A shared family debt is visible to members, but only its actual sender gets a
 * personal receipt-confirmation notice. First-load and repeated reads are silent.
 */
export function shouldNotifyGuestReceiptConfirmation(
  wasVerifiedAt: string | null | undefined,
  verifiedAt: string | null,
  isPaymentSender: boolean,
): boolean {
  return isPaymentSender && becameVerified(wasVerifiedAt, verifiedAt);
}
