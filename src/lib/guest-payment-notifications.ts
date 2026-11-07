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
  return incoming.map((row) => {
    const old = previous?.find((person) => person.personId === row.personId);
    return {
      ...row,
      declaredPaidAt: row.declaredPaidAt ?? old?.declaredPaidAt ?? null,
      verifiedAt: row.verifiedAt ?? old?.verifiedAt ?? null,
    };
  });
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
