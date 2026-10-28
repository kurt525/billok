import { MAX_MONEY_CENTS } from './money';

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
  return totals;
}

/**
 * Add each participant's own, voluntary RUB tip to their item share.
 * This is a pure calculation, NOT an expense write: finalization must reload
 * tips under the receipt row lock before using the result.
 *
 * A member may leave a tip even if they consumed no item. Tip ownership is
 * never inferred from the receipt payer or item assignments.
 */
export function calculateTotalsWithPersonalTips(
  itemShares: ReadonlyMap<string, number>,
  personalTips: unknown,
  eligibleParticipantIds: ReadonlySet<string>,
): { userTotals: Map<string, number>; itemTotal: number; tipTotal: number; total: number } {
  if (
    personalTips !== undefined &&
    personalTips !== null &&
    (typeof personalTips !== 'object' || Array.isArray(personalTips))
  ) {
    throw new RangeError('Invalid personal tip data');
  }
  const tips = (personalTips ?? {}) as Record<string, unknown>;
  const userTotals = new Map<string, number>();
  let itemTotal = 0;
  let tipTotal = 0;
  for (const [userId, amount] of itemShares) {
    if (
      !eligibleParticipantIds.has(userId) ||
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      amount > MAX_MONEY_CENTS ||
      itemTotal + amount > MAX_MONEY_CENTS
    ) {
      throw new RangeError('Invalid participant or receipt share');
    }
    userTotals.set(userId, amount);
    itemTotal += amount;
  }
  for (const [userId, tip] of Object.entries(tips)) {
    if (
      !eligibleParticipantIds.has(userId) ||
      !Number.isSafeInteger(tip) ||
      (tip as number) < 0 ||
      (tip as number) > MAX_MONEY_CENTS
    ) {
      throw new RangeError('Invalid voluntary tip or participant');
    }
    const amount = tip as number;
    if (tipTotal + amount > MAX_MONEY_CENTS || (userTotals.get(userId) ?? 0) + amount > MAX_MONEY_CENTS) {
      throw new RangeError('Personal tip total exceeds RUB storage limit');
    }
    tipTotal += amount;
    if (amount > 0) userTotals.set(userId, (userTotals.get(userId) ?? 0) + amount);
  }
  const total = itemTotal + tipTotal;
  if (total > MAX_MONEY_CENTS) {
    throw new RangeError('Receipt with tips exceeds RUB storage limit');
  }
  return { userTotals, itemTotal, tipTotal, total };
}
