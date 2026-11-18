/**
 * Aggregate expense totals in the currency stored by each group.
 * BillOK creates only RUB expenses. Legacy mismatched currencies must not
 * be added to RUB amounts or converted through abandoned FX fields.
 * Mark such a group's total unavailable rather than mislabel its kopecks.
 */
export type ExpenseCurrencyAggregate = {
  groupId: string;
  currency: string;
  _sum: { amount: number | null };
};

export function totalsInGroupCurrency(
  groups: readonly { id: string; currency: string }[],
  sums: readonly ExpenseCurrencyAggregate[],
): Map<string, number | null> {
  const currencies = new Map(groups.map((group) => [group.id, group.currency]));
  const totals = new Map<string, number | null>(groups.map((group) => [group.id, 0]));

  for (const entry of sums) {
    const groupCurrency = currencies.get(entry.groupId);
    if (!groupCurrency) continue;

    const previous = totals.get(entry.groupId);
    if (previous == null || entry.currency !== groupCurrency) {
      totals.set(entry.groupId, null);
      continue;
    }
    totals.set(entry.groupId, previous + (entry._sum.amount ?? 0));
  }

  return totals;
}
