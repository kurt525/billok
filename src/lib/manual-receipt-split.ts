import { MAX_MONEY_CENTS } from './money';

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

/** For the single-item legacy mode, keep the organizer's correction separate from food consumption. */
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
  const organizerCorrectionCents = amount - used;
  result.set(creatorId, (result.get(creatorId) ?? 0) + organizerCorrectionCents);
  return { totals: result, organizerCorrectionCents };
}

export type ManualReceiptAllocation = {
  totals: Map<string, number>;
  /** Non-consumption rounding assigned to the specific receipt creator, never to a fictitious dish. */
  organizerCorrectionCents: number;
};

/**
 * Return the existing settlement amounts plus a separately identifiable
 * creator-only rounding correction. The correction is not an item assignment:
 * ReceiptItemAssignment remains the list of actual consumers.
 */
export function calculateManualReceiptAllocation(params: {
  items: { id: string; totalPrice: number }[];
  assignments: ManualAssignment[];
  creatorId: string;
}): ManualReceiptAllocation {
  const totals = new Map<string, number>();
  let organizerCorrectionCents = 0;
  const itemMap = new Map(params.items.map((item) => [item.id, item.totalPrice]));
  // A single dish still follows the existing creator-rounding rule. The
  // cross-item balancing path is only used once there are multiple positions.
  if (params.assignments.length <= 1) {
    for (const assignment of params.assignments) {
      const amount = itemMap.get(assignment.receiptItemId);
      if (amount === undefined || !assignment.people.length) {
        throw new RangeError('Receipt item not found or has no portions');
      }
      const allocation = splitCents(amount, assignment.people, params.creatorId);
      for (const [userId, share] of allocation.totals) {
        totals.set(userId, (totals.get(userId) ?? 0) + share);
      }
      organizerCorrectionCents += allocation.organizerCorrectionCents;
    }
    return { totals, organizerCorrectionCents };
  }

  // Exact per-item floors are computed using integers. Each outstanding
  // kopeck stays on its own item and may go only to a person who consumed
  // that item. Carry the fractional deficit across item boundaries so the
  // next kopeck compensates whoever was rounded down by earlier dishes.
  const fractionalDeficit = new Map<string, number>();
  const exactTotals = new Map<string, number>();
  const awardedByItem = new Map<string, Set<string>>();
  const kopeckAwards: { itemId: string; userId: string | null; consumers: string[] }[] = [];
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
      exactTotals.set(person.userId, (exactTotals.get(person.userId) ?? 0) + floor + fractional);
      fractionalDeficit.set(person.userId, (fractionalDeficit.get(person.userId) ?? 0) + fractional);
      used += floor;
      return { userId: person.userId, fractional };
    });
    let remaining = amount - used;
    const awarded = new Set<string>();
    awardedByItem.set(assignment.receiptItemId, awarded);
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
      kopeckAwards.push({
        itemId: assignment.receiptItemId,
        userId: next.userId,
        consumers: candidates.map((person) => person.userId),
      });
      remaining--;
    }
  }

  // 2.17.2: the carried deficits ordinarily let consumers offset one
  // another across dishes. Some combinations of consumers and tiny prices
  // still leave an individual paying > half a kopeck above their exact
  // receipt-wide proportional consumption. Before charging the organizer,
  // search for a chain of legal 1-kopeck transfers *within the same items*.
  // Every transfer preserves each dish's total and goes only to its eaters.
  // If there is no such chain, the extra kopeck becomes a separate
  // organizer correction, never a fictitious ReceiptItemAssignment.
  const excess = (userId: string) => (totals.get(userId) ?? 0) - (exactTotals.get(userId) ?? 0);
  const isExcess = (userId: string) => excess(userId) > 0.5 + 1e-7;
  type AwardMove = { awardIndex: number; from: string; to: string };
  const findConsumerTransfer = (source: string): AwardMove[] | null => {
    const visited = new Set([source]);
    const queue: { userId: string; path: AwardMove[] }[] = [{ userId: source, path: [] }];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (const [awardIndex, award] of kopeckAwards.entries()) {
        if (award.userId !== current.userId) continue;
        for (const candidate of award.consumers) {
          if (candidate === current.userId || awardedByItem.get(award.itemId)?.has(candidate)) continue;
          const path = [...current.path, { awardIndex, from: current.userId, to: candidate }];
          // A receiver may gain a kopeck only if its own receipt-wide
          // rounded share stays within half a kopeck of its exact food cost.
          if (excess(candidate) < -0.5 + 1e-7) return path;
          if (!visited.has(candidate)) {
            visited.add(candidate);
            queue.push({ userId: candidate, path });
          }
        }
      }
    }
    return null;
  };

  for (;;) {
    const overcharged = [...totals.keys()]
      .filter((userId) => isExcess(userId) && kopeckAwards.some((award) => award.userId === userId))
      .sort((a, b) => excess(b) - excess(a) || a.localeCompare(b))[0];
    if (!overcharged) break;

    const path = findConsumerTransfer(overcharged);
    if (path) {
      // Apply the augmenting path backwards so each recipient is freed on
      // their old item before receiving a penny from another one.
      for (const move of path.reverse()) {
        const award = kopeckAwards[move.awardIndex]!;
        const winners = awardedByItem.get(award.itemId)!;
        winners.delete(move.from);
        winners.add(move.to);
        award.userId = move.to;
      }
      totals.set(overcharged, (totals.get(overcharged) ?? 0) - 1);
      const receiver = path[0]!.to;
      // Reversed path starts at the terminal edge; its first "to" is
      // the only participant whose total increases.
      totals.set(receiver, (totals.get(receiver) ?? 0) + 1);
      continue;
    }

    // No real eater can absorb the indivisible penny without an excessive
    // receipt-wide surplus; the organizer bears it without eating that dish.
    const award = kopeckAwards.find((row) => row.userId === overcharged)!;
    awardedByItem.get(award.itemId)!.delete(overcharged);
    award.userId = null;
    totals.set(overcharged, (totals.get(overcharged) ?? 0) - 1);
    totals.set(params.creatorId, (totals.get(params.creatorId) ?? 0) + 1);
    organizerCorrectionCents++;
  }

  // Keep the creator in the settlement even when they did not eat.
  if (!totals.has(params.creatorId)) totals.set(params.creatorId, 0);
  return { totals, organizerCorrectionCents };
}

/** Stable existing API for preview, finalization and personal-tip accounting. */
export function calculateManualReceiptTotals(
  params: Parameters<typeof calculateManualReceiptAllocation>[0],
): Map<string, number> {
  return calculateManualReceiptAllocation(params).totals;
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
