/**
 * Issue 3.24.1.1: a receipt keeps one immutable personId per diner.
 * A payment group is an optional server-owned relationship between those IDs,
 * not a replacement person, item assignment, receipt, or additional expense.
 *
 * Its representative is a member of that same group. Only the representative
 * will eventually be permitted to declare the one group payment.
 */
export type ReceiptPaymentPerson = {
  id?: string;
  paymentGroupRepresentativeId?: string;
};

export type ReceiptPersonTotal = {
  personIndex: number;
  total: number; // kopecks, includes only this person's voluntary tip
  tip: number; // kopecks, may be zero
};

export type ReceiptPaymentMembership = {
  representativeId: string;
  memberIds: string[];
  memberIndices: number[];
  grouped: boolean;
};

export type ReceiptGroupAmount = ReceiptPaymentMembership & {
  totalCents: number;
  tipCents: number;
  members: { personId: string; personIndex: number; amountCents: number; tipCents: number }[];
};

function requireSafeCents(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid receipt payment amount in kopecks');
  }
}

function addCents(a: number, b: number): number {
  requireSafeCents(a);
  requireSafeCents(b);
  const total = a + b;
  requireSafeCents(total);
  return total;
}

/**
 * Validate stored memberships before any financial grouping. No group can
 * contain the receipt payer, share a member with another group, or designate
 * a phantom/foreign representative. A group has at least two distinct people;
 * everyone else remains an independent debtor.
 */
export function receiptPaymentMemberships(
  people: readonly ReceiptPaymentPerson[],
  paidByIndex: number,
): ReceiptPaymentMembership[] {
  if (!Number.isSafeInteger(paidByIndex) || paidByIndex < 0 || paidByIndex >= people.length) {
    throw new Error('Invalid receipt payer');
  }

  const byId = new Map<string, number>();
  people.forEach((person, index) => {
    if (typeof person.id !== 'string' || !person.id.trim() || byId.has(person.id)) {
      throw new Error('Receipt participants need unique stable person IDs');
    }
    byId.set(person.id, index);
  });
  if (people[paidByIndex]?.paymentGroupRepresentativeId !== undefined) {
    throw new Error('The receipt payer cannot join a reimbursement group');
  }

  const buckets = new Map<string, ReceiptPaymentMembership>();
  for (const [index, person] of people.entries()) {
    if (index === paidByIndex) continue;
    const id = person.id!;
    const assignedRepresentative = person.paymentGroupRepresentativeId;
    const representativeId = assignedRepresentative === undefined ? id : assignedRepresentative;
    const representativeIndex = byId.get(representativeId);
    if (representativeIndex === undefined || representativeIndex === paidByIndex) {
      throw new Error('Payment group representative must be a non-payer from this receipt');
    }
    if (assignedRepresentative !== undefined) {
      const representative = people[representativeIndex]!;
      if (representative.paymentGroupRepresentativeId !== representativeId) {
        throw new Error('Payment group representative must explicitly lead their own group');
      }
    }

    let bucket = buckets.get(representativeId);
    if (!bucket) {
      bucket = { representativeId, memberIds: [], memberIndices: [], grouped: assignedRepresentative !== undefined };
      buckets.set(representativeId, bucket);
    }
    bucket.memberIds.push(id);
    bucket.memberIndices.push(index);
    bucket.grouped ||= assignedRepresentative !== undefined;
  }

  for (const bucket of buckets.values()) {
    if (bucket.grouped && (bucket.memberIds.length < 2 || !bucket.memberIds.includes(bucket.representativeId))) {
      throw new Error('A payment group needs its representative and at least one other diner');
    }
  }
  return [...buckets.values()];
}

/**
 * Aggregates finalized person totals WITHOUT redistributing or rounding
 * their dish portions or tips. This produces ONE debtor row per payment group.
 * The payer's personal share is excluded from reimbursements, but included
 * when reconciling the single original restaurant receipt.
 */
export function aggregateReceiptPaymentGroups(
  people: readonly ReceiptPaymentPerson[],
  paidByIndex: number,
  summary: readonly ReceiptPersonTotal[],
  receiptTotalCents: number,
): { groups: ReceiptGroupAmount[]; payerTotalCents: number; totalCents: number; tipsCents: number } {
  requireSafeCents(receiptTotalCents);
  const memberships = receiptPaymentMemberships(people, paidByIndex);
  if (summary.length !== people.length) throw new Error('Missing personal receipt totals');
  const byIndex = new Map<number, ReceiptPersonTotal>();
  let totalCents = 0;
  let tipsCents = 0;
  for (const line of summary) {
    if (
      !Number.isSafeInteger(line.personIndex) ||
      line.personIndex < 0 ||
      line.personIndex >= people.length ||
      byIndex.has(line.personIndex)
    ) {
      throw new Error('Invalid or duplicated receipt person index');
    }
    requireSafeCents(line.total);
    requireSafeCents(line.tip);
    if (line.tip > line.total) throw new Error('Personal tip exceeds personal total');
    byIndex.set(line.personIndex, line);
    totalCents = addCents(totalCents, line.total);
    tipsCents = addCents(tipsCents, line.tip);
  }
  if (totalCents - tipsCents !== receiptTotalCents) {
    throw new Error('Grouped debt does not reconcile to the original receipt and personal tips');
  }
  const payerTotalCents = byIndex.get(paidByIndex)!.total;
  const groups = memberships.map((membership) => {
    let groupTotal = 0;
    let groupTips = 0;
    const members = membership.memberIndices.map((index) => {
      const personTotal = byIndex.get(index)!;
      groupTotal = addCents(groupTotal, personTotal.total);
      groupTips = addCents(groupTips, personTotal.tip);
      return {
        personId: people[index]!.id!,
        personIndex: index,
        amountCents: personTotal.total,
        tipCents: personTotal.tip,
      };
    });
    return {
      ...membership,
      totalCents: groupTotal,
      tipCents: groupTips,
      members,
    };
  });
  const groupGrandTotal = groups.reduce((total, group) => addCents(total, group.totalCents), payerTotalCents);
  if (groupGrandTotal !== totalCents) {
    throw new Error('A person was counted more than once or omitted from grouped payments');
  }
  return { groups, payerTotalCents, totalCents, tipsCents };
}

/**
 * Replace the complete set of reimbursement groups atomically.
 * [] breaks every group; a different leader transfers responsibility.
 * Keep stable person IDs and all unrelated data unchanged.
 */
export function setReceiptPaymentGroups<T extends ReceiptPaymentPerson>(
  people: readonly T[],
  paidByIndex: number,
  groups: readonly { representativeId: string; memberIds: readonly string[] }[],
): T[] {
  receiptPaymentMemberships(people, paidByIndex);
  const assigned = new Map<string, string>();
  const byId = new Set(people.map((person) => person.id));
  for (const group of groups) {
    if (group.memberIds.length < 2 || new Set(group.memberIds).size !== group.memberIds.length) {
      throw new Error('Each payment group must have two or more distinct people');
    }
    if (!group.memberIds.includes(group.representativeId)) {
      throw new Error('The representative must belong to their own group');
    }
    if (group.memberIds.includes(people[paidByIndex]!.id!)) {
      throw new Error('The payer cannot join a reimbursement group');
    }
    for (const id of group.memberIds) {
      if (!byId.has(id) || assigned.has(id)) {
        throw new Error('Missing or duplicated person in payment groups');
      }
      assigned.set(id, group.representativeId);
    }
  }
  const updated = people.map((person) => {
    const representativeId = assigned.get(person.id!);
    const { paymentGroupRepresentativeId: _previous, ...other } = person;
    void _previous;
    return {
      ...other,
      ...(representativeId !== undefined ? { paymentGroupRepresentativeId: representativeId } : {}),
    } as T;
  });
  receiptPaymentMemberships(updated, paidByIndex);
  return updated;
}
