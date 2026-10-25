/**
 * Integer-only proportional splitting. Each participant gets the floor of their
 * proportional item cost; remaining kopecks always belong to the receipt creator,
 * even if they consumed nothing and another member paid the bill.
 */
export type ManualAssignment = {
  receiptItemId: string;
  people: { userId: string; parts: number }[];
};

function splitCents(amount: number, people: { userId: string; parts: number }[], creatorId: string) {
  const totalParts = people.reduce((sum, p) => sum + p.parts, 0);
  if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(totalParts) || totalParts <= 0) {
    throw new RangeError('Invalid receipt amount or consumed portions');
  }
  const result = new Map<string, number>();
  let used = 0;
  for (const person of people) {
    if (
      !person.userId ||
      !Number.isSafeInteger(person.parts) ||
      person.parts < 1 ||
      person.parts > 10000 ||
      result.has(person.userId)
    ) {
      throw new RangeError('Invalid or duplicate portion participant');
    }
    const share = Number((BigInt(amount) * BigInt(person.parts)) / BigInt(totalParts));
    result.set(person.userId, share);
    used += share;
  }
  result.set(creatorId, (result.get(creatorId) ?? 0) + amount - used);
  return result;
}

export function calculateManualReceiptTotals(params: {
  items: { id: string; totalPrice: number }[];
  assignments: ManualAssignment[];
  creatorId: string;
  tax?: number;
  tip?: number;
}): Map<string, number> {
  const totals = new Map<string, number>();
  const itemMap = new Map(params.items.map((item) => [item.id, item.totalPrice]));
  for (const assignment of params.assignments) {
    const amount = itemMap.get(assignment.receiptItemId);
    if (amount === undefined || !assignment.people.length) {
      throw new RangeError('Receipt item not found or has no portions');
    }
    for (const [userId, share] of splitCents(amount, assignment.people, params.creatorId)) {
      totals.set(userId, (totals.get(userId) ?? 0) + share);
    }
  }
  const extra = (params.tax ?? 0) + (params.tip ?? 0);
  if (!Number.isSafeInteger(extra) || extra < 0) throw new RangeError('Invalid tax or tip');
  if (extra) {
    const taxable = [...totals.entries()]
      .filter(([, share]) => share > 0)
      .map(([userId, parts]) => ({ userId, parts }));
    if (taxable.length) {
      for (const [userId, share] of splitCents(extra, taxable, params.creatorId)) {
        totals.set(userId, (totals.get(userId) ?? 0) + share);
      }
    } else {
      totals.set(params.creatorId, (totals.get(params.creatorId) ?? 0) + extra);
    }
  }
  return totals;
}
