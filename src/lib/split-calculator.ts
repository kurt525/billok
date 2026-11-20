import { MAX_MONEY_CENTS } from './money';

/**
 * Pure function to calculate per-person totals with proportional tax/tip distribution.
 * Used by both the authenticated receipt flow and the guest split flow.
 */
export function calculateSplitTotals(params: {
  items: { totalPrice: number }[];
  assignments: { itemIndex: number; personIndices: number[]; portions?: number[] }[];
  tax: number;
  tip: number;
  peopleCount: number;
  personWeights?: number[]; // weight for each person index (default all 1)
  balanceAcrossItems?: boolean; // only new personal-link claim sessions; legacy splits stay unchanged
  organizerIndex?: number; // stable creator ID mapped to current people order, never the payer
}): {
  personIndex: number;
  itemTotal: number;
  tax: number;
  tip: number;
  total: number;
  roundingCorrectionCents?: number;
}[] {
  const { items, assignments, tax, tip, personWeights } = params;
  const balanced = params.balanceAcrossItems
    ? balancedGuestItemShares(items, assignments, personWeights, params.organizerIndex)
    : null;

  // Calculate per-person item subtotals
  const personSubtotals = new Map<number, number>();

  for (const assignment of assignments) {
    const item = items[assignment.itemIndex];
    if (!item || assignment.personIndices.length === 0) continue;

    const amounts =
      balanced?.allocation.get(assignment.itemIndex) ??
      splitItemPrice(item.totalPrice, assignment.personIndices, personWeights, assignment.portions);
    for (const [i, personIdx] of assignment.personIndices.entries()) {
      personSubtotals.set(personIdx, (personSubtotals.get(personIdx) ?? 0) + amounts[i]!);
    }
  }

  if (balanced?.organizerCorrectionCents && params.organizerIndex !== undefined) {
    const organizerIndex = params.organizerIndex;
    personSubtotals.set(organizerIndex, (personSubtotals.get(organizerIndex) ?? 0) + balanced.organizerCorrectionCents);
  }

  const actualSubtotal = Array.from(personSubtotals.values()).reduce((a, b) => a + b, 0);
  const totalAmount = actualSubtotal + tax + tip;

  const results: ReturnType<typeof calculateSplitTotals> = [];
  let allocated = 0;
  const entries = Array.from(personSubtotals.entries());

  for (const [i, [personIdx, itemTotal]] of entries.entries()) {
    if (i === entries.length - 1) {
      // Last person gets remainder to prevent off-by-one
      const total = totalAmount - allocated;
      results.push({
        personIndex: personIdx,
        itemTotal,
        ...(balanced?.organizerCorrectionCents && personIdx === params.organizerIndex
          ? { roundingCorrectionCents: balanced.organizerCorrectionCents }
          : {}),
        tax: total - itemTotal - Math.round(tip * (actualSubtotal > 0 ? itemTotal / actualSubtotal : 0)),
        tip: Math.round(tip * (actualSubtotal > 0 ? itemTotal / actualSubtotal : 0)),
        total,
      });
    } else {
      const proportion = actualSubtotal > 0 ? itemTotal / actualSubtotal : 0;
      const personTax = Math.round(tax * proportion);
      const personTip = Math.round(tip * proportion);
      const total = itemTotal + personTax + personTip;
      results.push({
        personIndex: personIdx,
        itemTotal,
        ...(balanced?.organizerCorrectionCents && personIdx === params.organizerIndex
          ? { roundingCorrectionCents: balanced.organizerCorrectionCents }
          : {}),
        tax: personTax,
        tip: personTip,
        total,
      });
      allocated += total;
    }
  }

  return results;
}

/**
 * Add only each guest's own voluntary RUB tip to already allocated item shares.
 * Only someone assigned an item may tip. No proportional tip distribution,
 * no implicit charges, and every amount remains integer kopecks.
 */
export function addPersonalGuestTips(
  shares: ReturnType<typeof calculateSplitTotals>,
  people: readonly { tipCents?: number | undefined }[],
  consumingPersonIndices?: ReadonlySet<number>,
): ReturnType<typeof calculateSplitTotals> {
  const results = shares.map((share) => ({ ...share }));
  const indices = new Set<number>();
  let total = 0;
  for (const share of results) {
    if (
      !Number.isSafeInteger(share.personIndex) ||
      share.personIndex < 0 ||
      share.personIndex >= people.length ||
      indices.has(share.personIndex) ||
      !Number.isSafeInteger(share.total) ||
      share.total < 0 ||
      total + share.total > MAX_MONEY_CENTS
    ) {
      throw new RangeError('Invalid existing guest share');
    }
    indices.add(share.personIndex);
    total += share.total;
  }
  for (const [personIndex, person] of people.entries()) {
    const tip = person.tipCents ?? 0;
    if (!Number.isSafeInteger(tip) || tip < 0 || tip > MAX_MONEY_CENTS || total + tip > MAX_MONEY_CENTS) {
      throw new RangeError('Invalid voluntary guest tip or total');
    }
    if (tip === 0) continue;
    const previous = results.find((share) => share.personIndex === personIndex);
    if (
      !previous ||
      (consumingPersonIndices !== undefined && !consumingPersonIndices.has(personIndex)) ||
      (consumingPersonIndices === undefined &&
        previous.roundingCorrectionCents !== undefined &&
        previous.itemTotal === previous.roundingCorrectionCents)
    ) {
      throw new RangeError('Cannot charge personal tips without assigned items');
    }
    previous.tip += tip;
    previous.total += tip;
    total += tip;
  }
  return results;
}

/**
 * How one item's price is divided among the people on it, in cents, in `personIndices` order.
 * `calculateSplitTotals` adds these up into each person's item total.
 */
function splitItemPrice(
  totalPrice: number,
  personIndices: number[],
  personWeights?: number[],
  portions?: number[],
): number[] {
  if (portions) {
    if (
      portions.length !== personIndices.length ||
      portions.some((part) => !Number.isSafeInteger(part) || part < 1 || part > 10000)
    ) {
      throw new RangeError('Invalid personal portions');
    }
    const total = portions.reduce((sum, part) => sum + part, 0);
    if (!Number.isSafeInteger(total) || total <= 0) throw new RangeError('Invalid total portions');
    const result = portions.map((part) => Number((BigInt(totalPrice) * BigInt(part)) / BigInt(total)));
    let left = totalPrice - result.reduce((sum, part) => sum + part, 0);
    for (let i = 0; i < result.length && left > 0; i++, left--) result[i]!++;
    return result;
  }
  if (personWeights) {
    // Weighted proportional splitting: each share rounded down, the last person taking what's left
    const totalWeight = itemWeight(personIndices, personWeights);
    let allocated = 0;
    return personIndices.map((personIdx, i) => {
      const amount =
        i === personIndices.length - 1
          ? totalPrice - allocated
          : Math.floor((totalPrice * (personWeights[personIdx] ?? 1)) / totalWeight);
      allocated += amount;
      return amount;
    });
  }
  // Equal splitting (original behavior): the leftover cents go to the first people
  const perPerson = Math.floor(totalPrice / personIndices.length);
  const remainder = totalPrice - perPerson * personIndices.length;
  return personIndices.map((_, i) => perPerson + (i < remainder ? 1 : 0));
}

/**
 * Round within each item, but carry each diner's fractional shortfall across
 * the receipt. Awards are limited to actual consumers of the current dish;
 * this prevents a rounding penny from becoming a fictitious purchased item.
 * The same allocation map is used for preview, finalization and line detail.
 */
function balancedGuestItemShares(
  items: readonly { totalPrice: number }[],
  assignments: readonly { itemIndex: number; personIndices: number[]; portions?: number[] }[],
  personWeights?: number[],
  organizerIndex?: number,
): { allocation: Map<number, number[]>; organizerCorrectionCents: number } {
  const deficits = new Map<number, number>();
  const exactTotals = new Map<number, number>();
  const totals = new Map<number, number>();
  const allocation = new Map<number, number[]>();
  const awardedByItem = new Map<number, Set<number>>();
  const awards: { itemIndex: number; personIndex: number | null; consumers: number[] }[] = [];

  for (const assignment of assignments) {
    const item = items[assignment.itemIndex];
    const people = assignment.personIndices;
    if (!item || people.length === 0) continue;
    if (!Number.isSafeInteger(item.totalPrice) || item.totalPrice < 0 || item.totalPrice > MAX_MONEY_CENTS) {
      throw new RangeError('Invalid guest receipt item amount');
    }
    if (new Set(people).size !== people.length) throw new RangeError('Duplicate guest consumer');
    const portions = assignment.portions;
    if (portions && portions.length !== people.length) throw new RangeError('Invalid personal portions');
    const weights = people.map((personIndex, index) => {
      const value = portions ? portions[index] : (personWeights?.[personIndex] ?? 1);
      if (value === undefined || !Number.isSafeInteger(value) || value < 1 || value > 10000) {
        throw new RangeError('Invalid guest portion weight');
      }
      return value;
    });
    const denominator = weights.reduce((sum, weight) => sum + weight, 0);
    const prices = weights.map((weight) => Number((BigInt(item.totalPrice) * BigInt(weight)) / BigInt(denominator)));
    const fractions = weights.map(
      (weight) => Number((BigInt(item.totalPrice) * BigInt(weight)) % BigInt(denominator)) / denominator,
    );
    const candidates = people.map((personIndex, index) => {
      deficits.set(personIndex, (deficits.get(personIndex) ?? 0) + fractions[index]!);
      exactTotals.set(personIndex, (exactTotals.get(personIndex) ?? 0) + prices[index]! + fractions[index]!);
      totals.set(personIndex, (totals.get(personIndex) ?? 0) + prices[index]!);
      return { personIndex, index };
    });
    let remaining = item.totalPrice - prices.reduce((sum, price) => sum + price, 0);
    const awarded = new Set<number>();
    awardedByItem.set(assignment.itemIndex, awarded);
    while (remaining > 0) {
      const chosen = candidates
        .filter((candidate) => !awarded.has(candidate.personIndex))
        .sort(
          (a, b) =>
            (deficits.get(b.personIndex) ?? 0) - (deficits.get(a.personIndex) ?? 0) ||
            fractions[b.index]! - fractions[a.index]! ||
            a.personIndex - b.personIndex,
        )[0];
      if (!chosen) throw new RangeError('Invalid guest remainder');
      prices[chosen.index]!++;
      totals.set(chosen.personIndex, (totals.get(chosen.personIndex) ?? 0) + 1);
      deficits.set(chosen.personIndex, (deficits.get(chosen.personIndex) ?? 0) - 1);
      awarded.add(chosen.personIndex);
      awards.push({ itemIndex: assignment.itemIndex, personIndex: chosen.personIndex, consumers: [...people] });
      remaining--;
    }
    allocation.set(assignment.itemIndex, prices);
  }

  // Only new guest claim sessions with an unambiguous, stable creator identity
  // use the fallback. Legacy direct splits and old claim data retain their
  // prior calculation. Never infer creator identity from the payer or array order.
  if (organizerIndex === undefined || organizerIndex < 0) return { allocation, organizerCorrectionCents: 0 };

  const surplus = (personIndex: number) => (totals.get(personIndex) ?? 0) - (exactTotals.get(personIndex) ?? 0);
  type AwardMove = { awardIndex: number; from: number; to: number };
  const findConsumerTransfer = (source: number): AwardMove[] | null => {
    const visited = new Set([source]);
    const queue: { personIndex: number; path: AwardMove[] }[] = [{ personIndex: source, path: [] }];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (const [awardIndex, award] of awards.entries()) {
        if (award.personIndex !== current.personIndex) continue;
        for (const candidate of award.consumers) {
          if (candidate === current.personIndex || awardedByItem.get(award.itemIndex)?.has(candidate)) continue;
          const path = [...current.path, { awardIndex, from: current.personIndex, to: candidate }];
          if (surplus(candidate) < -0.5 + 1e-7) return path;
          if (!visited.has(candidate)) {
            visited.add(candidate);
            queue.push({ personIndex: candidate, path });
          }
        }
      }
    }
    return null;
  };

  // Keep the same half-kopeck receipt-wide target as manual group receipts.
  // First seek transfers only between consumers of each actual item. When no
  // connected consumer can accept a kopeck, it is a separate creator correction
  // rather than a purchase fictitiously assigned to the organizer.
  let organizerCorrectionCents = 0;
  for (;;) {
    const overcharged = [...totals.keys()]
      .filter(
        (personIndex) => surplus(personIndex) > 0.5 + 1e-7 && awards.some((award) => award.personIndex === personIndex),
      )
      .sort((a, b) => surplus(b) - surplus(a) || a - b)[0];
    if (overcharged === undefined) break;
    const path = findConsumerTransfer(overcharged);
    if (path) {
      const terminalReceiver = path[path.length - 1]!.to;
      for (const move of path.reverse()) {
        const award = awards[move.awardIndex]!;
        const winners = awardedByItem.get(award.itemIndex)!;
        winners.delete(move.from);
        winners.add(move.to);
        const indices = assignments.find((entry) => entry.itemIndex === award.itemIndex)!.personIndices;
        const prices = allocation.get(award.itemIndex)!;
        prices[indices.indexOf(move.from)]!--;
        prices[indices.indexOf(move.to)]!++;
        award.personIndex = move.to;
      }
      totals.set(overcharged, (totals.get(overcharged) ?? 0) - 1);
      totals.set(terminalReceiver, (totals.get(terminalReceiver) ?? 0) + 1);
      continue;
    }
    const award = awards.find((entry) => entry.personIndex === overcharged)!;
    awardedByItem.get(award.itemIndex)!.delete(overcharged);
    const prices = allocation.get(award.itemIndex)!;
    const indices = assignments.find((entry) => entry.itemIndex === award.itemIndex)!.personIndices;
    prices[indices.indexOf(overcharged)]!--;
    award.personIndex = null;
    totals.set(overcharged, (totals.get(overcharged) ?? 0) - 1);
    organizerCorrectionCents++;
  }
  return { allocation, organizerCorrectionCents };
}

function itemWeight(personIndices: number[], personWeights: number[]): number {
  return Math.max(
    1,
    personIndices.reduce((sum, pi) => sum + (personWeights[pi] ?? 1), 0),
  );
}

/**
 * The items `personIndex` is on, each with the part of its price they pay (#278): the amounts
 * `calculateSplitTotals` adds up into their item total, so a summary that lists them adds up to
 * it. `share` is that part of the item as a reduced fraction.
 */
export function personItemShares(
  personIndex: number,
  params: Pick<
    Parameters<typeof calculateSplitTotals>[0],
    'items' | 'assignments' | 'personWeights' | 'balanceAcrossItems' | 'organizerIndex'
  >,
): { itemIndex: number; amount: number; share: { numerator: number; denominator: number } }[] {
  const { items, assignments, personWeights } = params;
  const balanced = params.balanceAcrossItems
    ? balancedGuestItemShares(items, assignments, personWeights, params.organizerIndex)
    : null;
  const shares: ReturnType<typeof personItemShares> = [];
  for (const { itemIndex, personIndices, portions } of assignments) {
    const item = items[itemIndex];
    if (!item || !personIndices.includes(personIndex)) continue;

    const amounts =
      balanced?.allocation.get(itemIndex) ?? splitItemPrice(item.totalPrice, personIndices, personWeights, portions);
    let amount = 0;
    let numerator = 0;
    for (const [i, personIdx] of personIndices.entries()) {
      if (personIdx !== personIndex) continue;
      amount += amounts[i]!;
      numerator += portions ? portions[i]! : personWeights ? (personWeights[personIdx] ?? 1) : 1;
    }
    const denominator = portions
      ? portions.reduce((sum, count) => sum + count, 0)
      : personWeights
        ? itemWeight(personIndices, personWeights)
        : personIndices.length;
    const divisor = greatestCommonDivisor(numerator, denominator);
    shares.push({ itemIndex, amount, share: { numerator: numerator / divisor, denominator: denominator / divisor } });
  }
  return shares;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * The weights a split of these people is calculated with: their group sizes, or none while
 * everyone counts once. Finalizing a claim session, the claim page and the split summary all use
 * it, since an unweighted split rounds a shared item's cents differently from one weighted 1 to 1.
 */
export function groupSizeWeights(people: { groupSize?: number | undefined }[]): { personWeights?: number[] } {
  const personWeights = people.map((p) => p.groupSize ?? 1);
  return personWeights.some((w) => w > 1) ? { personWeights } : {};
}

/**
 * Per-person totals for a split some items may still be missing from (the claim page, #264).
 * Tax and tip are prorated over every item, claimed or not, and the part that belongs to the
 * unclaimed items comes back as `unclaimed`. Once nothing with a price is left unclaimed (on a bill
 * whose items are all free, once every item is claimed), the people are `calculateSplitTotals`'
 * unchanged, so the page shows what finalizing will store.
 */
export function calculateClaimTotals(params: Parameters<typeof calculateSplitTotals>[0]): {
  people: ReturnType<typeof calculateSplitTotals>;
  unclaimed: { itemTotal: number; tax: number; tip: number; total: number } | null;
} {
  const people = calculateSplitTotals(params);
  const billSubtotal = params.items.reduce((sum, item) => sum + item.totalPrice, 0);
  const claimedSubtotal = people.reduce((sum, p) => sum + p.itemTotal, 0);
  // When every item is free, tax and tip can't follow prices: they stay unclaimed until every item is claimed
  const freeBill = billSubtotal <= 0;
  if (freeBill) {
    const claimed = new Set(params.assignments.filter((a) => a.personIndices.length > 0).map((a) => a.itemIndex));
    const allClaimed = params.items.every((_, i) => claimed.has(i));
    if (allClaimed || (params.tax === 0 && params.tip === 0)) return { people, unclaimed: null };
  } else if (claimedSubtotal >= billSubtotal) {
    return { people, unclaimed: null };
  }

  const subtotals = [...people.map((p) => p.itemTotal), billSubtotal - claimedSubtotal];
  const weights = freeBill ? [...people.map(() => 0), 1] : subtotals;
  const taxes = allocateProportionally(params.tax, weights);
  const tips = allocateProportionally(params.tip, weights);
  const withShares = (itemTotal: number, i: number) => ({
    itemTotal,
    tax: taxes[i]!,
    tip: tips[i]!,
    total: itemTotal + taxes[i]! + tips[i]!,
  });

  return {
    people: people.map((p, i) => ({
      personIndex: p.personIndex,
      ...(p.roundingCorrectionCents ? { roundingCorrectionCents: p.roundingCorrectionCents } : {}),
      ...withShares(p.itemTotal, i),
    })),
    unclaimed: withShares(subtotals[people.length]!, people.length),
  };
}

/**
 * Splits `amount` cents in proportion to `weights` (nonnegative, with a positive sum) so the
 * shares add up to `amount` exactly: each share is rounded down, and the cents left over go to
 * the largest remainders, earliest first on a tie. Rounding each share on its own could hand out
 * more than `amount` and leave the last share negative.
 */
function allocateProportionally(amount: number, weights: number[]): number[] {
  const sign = amount < 0 ? -1 : 1;
  const cents = Math.abs(amount);
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => Math.floor((cents * w) / weightTotal));
  const remainders = weights.map((w, i) => ({ i, remainder: cents * w - shares[i]! * weightTotal }));
  remainders.sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  let left = cents - shares.reduce((a, b) => a + b, 0);
  for (const { i } of remainders) {
    if (left <= 0) break;
    shares[i]! += 1;
    left -= 1;
  }
  return shares.map((share) => share * sign);
}
