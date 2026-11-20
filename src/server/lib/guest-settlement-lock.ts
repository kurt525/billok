import { createHash } from 'crypto';
import { AppError } from './app-error';

/** The private, versioned checksum of the exact reimbursement ledger finalized
 * in a single GuestSplit transaction. Names, account links and personal access
 * tokens are intentionally excluded: they never alter the amount owed.
 *
 * There is currently NO authorized post-finalization redistribution endpoint.
 * Any future explicitly authorized correction must create a new revision,
 * notify the participants, and separately reconcile existing declarations;
 * it must never just change this checksum or rewrite paymentDeclaredAmountCents.
 */
export type GuestSettlementLock = {
  version: 1;
  digest: string;
  lockedAt: string;
};

type Participant = { id?: string; paymentGroupRepresentativeId?: string };
type Share = { personIndex: number; total: number; tip: number };

export function guestSettlementDigest(input: {
  people: readonly Participant[];
  paidByIndex: number;
  summary: readonly Share[];
  receiptTotalCents: number;
}): string {
  const { people, paidByIndex, summary, receiptTotalCents } = input;
  const positions = people.map((person, index) => [
    index,
    person.id ?? null,
    person.paymentGroupRepresentativeId ?? null,
  ]);
  const shares = summary.map((entry) => [entry.personIndex, entry.total, entry.tip]).sort((a, b) => a[0]! - b[0]!);
  return createHash('sha256')
    .update(JSON.stringify([1, receiptTotalCents, paidByIndex, positions, shares]))
    .digest('hex');
}

export function assertGuestSettlementUnchanged(input: {
  receiptData: unknown;
  people: readonly Participant[];
  paidByIndex: number;
  summary: readonly Share[];
  receiptTotalCents: number;
}): void {
  const { receiptData, ...parts } = input;
  const lock =
    receiptData && typeof receiptData === 'object' && !Array.isArray(receiptData)
      ? (receiptData as { paymentSettlementLock?: unknown }).paymentSettlementLock
      : undefined;
  // Old finalized receipts predate the lock. Their existing saved summaries
  // continue to work; all NEW finalizations write this lock atomically.
  if (lock === undefined) return;
  if (
    !lock ||
    typeof lock !== 'object' ||
    Array.isArray(lock) ||
    (lock as GuestSettlementLock).version !== 1 ||
    typeof (lock as GuestSettlementLock).digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test((lock as GuestSettlementLock).digest) ||
    typeof (lock as GuestSettlementLock).lockedAt !== 'string' ||
    (lock as GuestSettlementLock).digest !== guestSettlementDigest(parts)
  ) {
    throw new AppError('PRECONDITION_FAILED', 'receiptSettlementChanged');
  }
}

export function assertGuestDeclaredAmountsUnchanged(input: {
  people: readonly (Participant & {
    paymentDeclaredAt?: string;
    paymentDeclaredAmountCents?: number;
  })[];
  paidByIndex: number;
  summary: readonly Share[];
  groupDebts: readonly { representativeId: string; totalCents: number }[] | null;
}): void {
  const { people, paidByIndex, summary, groupDebts } = input;
  const debts = groupDebts
    ? groupDebts.map((group) => ({
        person: people.find((entry) => entry.id === group.representativeId),
        amountCents: group.totalCents,
      }))
    : summary
        .filter((entry) => entry.personIndex !== paidByIndex && entry.total > 0)
        .map((entry) => ({ person: people[entry.personIndex], amountCents: entry.total }));
  for (const { person, amountCents } of debts) {
    if (
      person?.paymentDeclaredAt &&
      person.paymentDeclaredAmountCents !== undefined &&
      person.paymentDeclaredAmountCents !== amountCents
    ) {
      throw new AppError('PRECONDITION_FAILED', 'receiptSettlementChanged');
    }
  }
}
