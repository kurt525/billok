/**
 * An expense's amount is stored in its own currency. Only the converted
 * baseCurrencyAmount can be summed with the group's currency when they differ.
 * A missing conversion makes the group's total unknown, not zero.
 */
export type ExpenseCurrencyAggregate = {
  groupId: string;
  currency: string;
  _sum: { amount: number | null; baseCurrencyAmount: number | null };
  _count: { id: number; baseCurrencyAmount: number };
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

    const amount =
      entry.currency === groupCurrency
        ? (entry._sum.amount ?? 0)
        : entry._count.baseCurrencyAmount === entry._count.id
          ? (entry._sum.baseCurrencyAmount ?? 0)
          : null;

    const old = totals.get(entry.groupId);
    totals.set(entry.groupId, old == null || amount == null ? null : old + amount);
  }
  return totals;
}
