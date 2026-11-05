import { MAX_MONEY_CENTS } from './money';

/**
 * Integer-only proportional splitting. Each participant gets the floor of their
 * proportional item cost; remaining kopecks always belong to the receipt creator,
 * even if they consumed nothing and another member paid the bill.
 */
/**
 * A known original number of portions is optional. A missing total is not
 * inferred from item.quantity: that's the number of products on the bill.
 */
export function manualPortionProgress(consumedParts: readonly number[], declaredTotalParts?: number | null) {
  let countedParts = 0;
  for (const parts of consumedParts) {
    if (!Number.isSafeInteger(parts) || parts < 1 || parts > 10000) {
      throw new RangeError('Invalid consumed portions');
    }
    countedParts += parts;
    if (!Number.isSafeInteger(countedParts)) throw new RangeError('Too many portions');
  }
  if (declaredTotalParts === undefined || declaredTotalParts === null) {
    return { countedParts, declaredTotalParts: null, remainingParts: null, overclaimed: false };
  }
  if (!Number.isSafeInteger(declaredTotalParts) || declaredTotalParts < 1 || declaredTotalParts > 10000) {
    throw new RangeError('Invalid original number of portions');
  }
  return {
    countedParts,
    declaredTotalParts,
    remainingParts: Math.max(0, declaredTotalParts - countedParts),
    overclaimed: countedParts > declaredTotalParts,
  };
}

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
  // A single dish still follows the existing creator-rounding rule. The
  // cross-item balancing path is only used once there are multiple positions.
  if (params.assignments.length <= 1) {
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

  // Exact per-item floors are computed using integers. Each outstanding
  // kopeck stays on its own item and may go only to a person who consumed
  // that item. Carry the fractional deficit across item boundaries so the
  // next kopeck compensates whoever was rounded down by earlier dishes.
  const fractionalDeficit = new Map<string, number>();
  for (const assignment of params.assignments) {
    const amount = itemMap.get(assignment.receiptItemId);
    if (
      amount === undefined ||
      !assignment.people.length ||
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      amount > MAX_MONEY_CENTS
    ) {
      throw new RangeError('Receipt item not found or has invalid price/portions');
    }
    const parts = assignment.people.reduce((sum, p) => sum + p.parts, 0);
    if (!Number.isSafeInteger(parts) || parts <= 0) throw new RangeError('Invalid total parts');
    const seen = new Set<string>();
    let used = 0;
    const candidates = assignment.people.map((person) => {
      if (
        !person.userId ||
        !Number.isSafeInteger(person.parts) ||
        person.parts < 1 ||
        person.parts > 10000 ||
        seen.has(person.userId)
      ) {
        throw new RangeError('Invalid or duplicate portion participant');
      }
      seen.add(person.userId);
      const numerator = BigInt(amount) * BigInt(person.parts);
      const floor = Number(numerator / BigInt(parts));
      const fractional = Number(numerator % BigInt(parts)) / parts;
      totals.set(person.userId, (totals.get(person.userId) ?? 0) + floor);
      fractionalDeficit.set(person.userId, (fractionalDeficit.get(person.userId) ?? 0) + fractional);
      used += floor;
      return { userId: person.userId, fractional };
    });
    let remaining = amount - used;
    const awarded = new Set<string>();
    while (remaining > 0) {
      const next = candidates
        .filter((candidate) => !awarded.has(candidate.userId))
        .sort(
          (a, b) =>
            (fractionalDeficit.get(b.userId) ?? 0) - (fractionalDeficit.get(a.userId) ?? 0) ||
            b.fractional - a.fractional ||
            a.userId.localeCompare(b.userId),
        )[0];
      if (!next) throw new RangeError('Receipt rounding cannot be reconciled');
      totals.set(next.userId, (totals.get(next.userId) ?? 0) + 1);
      fractionalDeficit.set(next.userId, (fractionalDeficit.get(next.userId) ?? 0) - 1);
      awarded.add(next.userId);
      remaining--;
    }
  }
  // Preserve a stable zero-valued creator entry for downstream receipt
  // summaries. Adjustments reserved for section 2.17 are not added here.
  if (!totals.has(params.creatorId)) totals.set(params.creatorId, 0);
  return totals;
}

/**
 * Add each participant's own, voluntary RUB tip to their item share.
 * This is a pure calculation, NOT an expense write: finalization must reload
 * tips under the receipt row lock before using the result.
 *
 * Only a participant assigned at least one item may leave a tip. Ownership is
 * never inferred from the receipt payer or item assignments.
 */
export function calculateTotalsWithPersonalTips(
  itemShares: ReadonlyMap<string, number>,
  personalTips: unknown,
  eligibleParticipantIds: ReadonlySet<string>,
  consumingParticipantIds: ReadonlySet<string>,
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
    if (amount > 0 && !consumingParticipantIds.has(userId)) {
      throw new RangeError('Cannot charge tips to a member without assigned items');
    }
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
