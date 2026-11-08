import { AppError } from './app-error';
import { receiptPaymentMemberships } from '@/lib/receipt-payment-groups';
import type { GuestSessionPerson } from './guest-people';

export type DelegatedReceiptAction = 'claim-items' | 'item-parts' | 'personal-tip';

export type DelegatedReceiptAudit = {
  actorId: string;
  targetId: string;
  action: DelegatedReceiptAction;
  at: string;
  itemIndex?: number;
};

/**
 * Server-side authorization, using the caller's private person token and the
 * current receipt snapshot, not the public share link or editable display name.
 * A representative can edit another person only within their own validated
 * group. Ordinary self-edit continues to work for every diner.
 *
 * Historical, ungrouped claim screens permitted claiming on behalf of others;
 * preserve them until the group UI migration. Once any group exists, the
 * group boundary applies to all cross-person claim edits in that receipt.
 */
export function authorizeReceiptPersonEdit(
  people: readonly GuestSessionPerson[],
  paidByIndex: number,
  actorToken: string,
  targetId: string,
  allowLegacyClaims = false,
): { actorIndex: number; targetIndex: number; delegated: boolean } {
  const actorIndex = people.findIndex((person) => person.personToken === actorToken);
  const targetIndex = people.findIndex((person) => person.id === targetId);
  if (actorIndex < 0 || targetIndex < 0) {
    throw new AppError('FORBIDDEN', 'invalidPersonToken');
  }
  if (actorIndex === targetIndex) return { actorIndex, targetIndex, delegated: false };
  if (allowLegacyClaims && !people.some((person) => person.paymentGroupRepresentativeId !== undefined)) {
    return { actorIndex, targetIndex, delegated: false };
  }
  const actor = people[actorIndex]!;
  const target = people[targetIndex]!;
  try {
    const groups = receiptPaymentMemberships(people, paidByIndex);
    const myGroup = groups.find((group) => group.grouped && group.representativeId === actor.id);
    if (
      !myGroup ||
      !myGroup.memberIds.includes(targetId) ||
      actor.paymentGroupRepresentativeId !== actor.id ||
      target.paymentGroupRepresentativeId !== actor.id
    ) {
      throw new Error('Outside assigned group');
    }
  } catch {
    throw new AppError('FORBIDDEN', 'notParticipant');
  }
  return { actorIndex, targetIndex, delegated: true };
}

/** A bounded private audit: append only after a real delegated change, in the
 * same transaction as its target row. Do not expose bearer tokens in records.
 */
export function appendDelegatedReceiptAudit(
  target: GuestSessionPerson,
  actorId: string,
  targetId: string,
  action: DelegatedReceiptAction,
  itemIndex?: number,
): GuestSessionPerson {
  const entry: DelegatedReceiptAudit = {
    actorId,
    targetId,
    action,
    at: new Date().toISOString(),
    ...(itemIndex !== undefined ? { itemIndex } : {}),
  };
  return { ...target, delegatedReceiptAudit: [...(target.delegatedReceiptAudit ?? []), entry].slice(-20) };
}
