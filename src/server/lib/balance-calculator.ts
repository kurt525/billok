/**
 * Pure functions for balance calculation and debt simplification.
 * Extracted from the balances tRPC router for testability.
 */

export type MemberBalance = {
  userId: string;
  paid: number;
  owes: number;
  net: number;
};

export type SimplifiedDebt = {
  from: string;
  to: string;
  amount: number;
};

export type Expense = {
  paidById: string;
  amount: number;
  shares: { userId: string; amount: number }[];
};

export type Settlement = {
  fromId: string;
  toId: string;
  amount: number;
};

/**
 * Simplify a set of member balances into the minimum number of debts.
 * Uses a greedy algorithm: match largest creditor with largest debtor.
 */
export function simplifyDebts(balances: MemberBalance[]): SimplifiedDebt[] {
  const creditors: { userId: string; amount: number }[] = [];
  const debtors: { userId: string; amount: number }[] = [];

  for (const b of balances) {
    if (b.net > 0) creditors.push({ userId: b.userId, amount: b.net });
    if (b.net < 0) debtors.push({ userId: b.userId, amount: -b.net });
  }

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b) => b.amount - a.amount);

  const result: SimplifiedDebt[] = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor = debtors[di];
    // Unreachable given the loop condition above (ci/di are always in
    // bounds); guards the indexed access for noUncheckedIndexedAccess.
    if (!creditor || !debtor) break;

    const amount = Math.min(creditor.amount, debtor.amount);
    if (amount > 0) {
      result.push({
        from: debtor.userId,
        to: creditor.userId,
        amount,
      });
    }
    creditor.amount -= amount;
    debtor.amount -= amount;
    if (creditor.amount === 0) ci++;
    if (debtor.amount === 0) di++;
  }

  return result;
}

/**
 * Compute member balances from a set of expenses and settlements.
 * Returns per-member paid, owes, and net amounts.
 */
export function computeBalances(expenses: Expense[], settlements: Settlement[]): MemberBalance[] {
  const balanceMap = new Map<string, MemberBalance>();

  const getOrCreate = (userId: string): MemberBalance => {
    let b = balanceMap.get(userId);
    if (!b) {
      b = { userId, paid: 0, owes: 0, net: 0 };
      balanceMap.set(userId, b);
    }
    return b;
  };

  for (const expense of expenses) {
    const payer = getOrCreate(expense.paidById);
    // Amounts and individual shares are already fixed integer RUB kopecks.
    // Never multiply or re-round settled receipt shares via a legacy FX rate.
    payer.paid += expense.amount;
    for (const share of expense.shares) {
      const member = getOrCreate(share.userId);
      member.owes += share.amount;
    }
  }

  for (const settlement of settlements) {
    const from = getOrCreate(settlement.fromId);
    const to = getOrCreate(settlement.toId);
    from.paid += settlement.amount;
    to.owes += settlement.amount;
  }

  for (const b of balanceMap.values()) {
    b.net = b.paid - b.owes;
  }

  return Array.from(balanceMap.values());
}
