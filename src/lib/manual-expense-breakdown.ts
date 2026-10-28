import { calculateManualReceiptTotals, calculateTotalsWithPersonalTips } from './manual-receipt-split';

/**
 * Read-only reconciliation of a FINALIZED manual group receipt. Never infer
 * voluntary tips from a difference alone: compare every saved expense share
 * to the matching food share plus that member's own recorded tip.
 */
export function manualExpenseBreakdown(input: {
  receipt: {
    creatorId: string | null;
    extractedData: {
      currency: string;
      tax: number;
      tip: number;
      personalTips?: Record<string, number> | undefined;
    } | null;
  };
  items: readonly {
    id: string;
    totalPrice: number;
    assignments: readonly { userId: string; shareOfItem: number }[];
  }[];
  expense: {
    amount: number;
    currency: string;
    shares: readonly { userId: string; amount: number }[];
  };
}): { foodTotal: number; tipTotal: number; total: number } | null {
  const { receipt, items, expense } = input;
  const data = receipt.extractedData;
  if (
    !receipt.creatorId ||
    !data ||
    data.currency.toUpperCase() !== 'RUB' ||
    expense.currency.toUpperCase() !== 'RUB' ||
    data.tax !== 0 ||
    data.tip !== 0 ||
    items.length === 0 ||
    !Number.isSafeInteger(expense.amount) ||
    expense.shares.length === 0 ||
    new Set(expense.shares.map((share) => share.userId)).size !== expense.shares.length ||
    items.some((item) => item.assignments.length === 0)
  ) {
    return null;
  }

  try {
    const food = calculateManualReceiptTotals({
      items: items.map((item) => ({ id: item.id, totalPrice: item.totalPrice })),
      assignments: items.map((item) => ({
        receiptItemId: item.id,
        people: item.assignments.map((assignment) => ({
          userId: assignment.userId,
          parts: assignment.shareOfItem,
        })),
      })),
      creatorId: receipt.creatorId,
    });
    const consumers = new Set(items.flatMap((item) => item.assignments.map((assignment) => assignment.userId)));
    // Zero tips can be saved by members before they have any assignments.
    const validMembers = new Set([
      ...expense.shares.map((share) => share.userId),
      ...Object.keys(data.personalTips ?? {}),
    ]);
    const calculated = calculateTotalsWithPersonalTips(food, data.personalTips, validMembers, consumers);
    if (calculated.total !== expense.amount || calculated.userTotals.size !== expense.shares.length) return null;
    if (expense.shares.some((share) => calculated.userTotals.get(share.userId) !== share.amount)) return null;
    return { foodTotal: calculated.itemTotal, tipTotal: calculated.tipTotal, total: calculated.total };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
