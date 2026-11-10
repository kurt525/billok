import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { GuestWebPushSubscription } from './guest-web-push';

/** A person id as requests send it (personId / targetId), and as stored ids must be */
export const personIdSchema = z.string().uuid();

function isPersonId(id: unknown): id is string {
  return personIdSchema.safeParse(id).success;
}

/** A person in a guest claim session's `people` JSON. */
export type GuestSessionPerson = {
  // Identifies the person for as long as they are in the session. Their array index changes
  // when someone listed before them is removed, so the claim page targets people by id.
  // Public (getSession lists everyone's). People saved without one (claim sessions from before
  // ids existed, and quick splits from guest.createSplit) get one the first time getSession,
  // resumeSession or joinSession loads them (see assignPersonIds).
  id?: string;
  name: string;
  personToken?: string;
  // Server-only identity binding for the BillOK owner. Public person serializers
  // must never expose this user id; guests cannot assign it via any API input.
  accountUserId?: string;
  // 3.7: fixed guest place, distinct from a legacy unjoined named person.
  // A place can be renamed without changing its number or stable person id.
  guestSlotNumber?: number;
  // 3.9: immutable per-receipt visual key. Names and array indices may
  // change; this ID must remain on the same person.
  visualColorId?: number;
  // Trusted server-only marker for the uniquely reserved BillOK-owner name.
  // A registered creator named Илья is not necessarily the site owner.
  reservedOwner?: boolean;
  // Server-only timestamp: the participant personally saved their first
  // real edit. Until then 3.8 does not offer a recovery link.
  personalLinkReadyAt?: string;
  // 3.8.4: server-only audit of explicit creator reissues, no old credential.
  // Keeping the most recent request id makes a network retry idempotent.
  personalLinkRotation?: { requestKey: string; rotatedAt: string; count: number };
  groupSize?: number; // defaults to 1, > 1 means this person represents a group
  // 3.24.1.1: optional server-controlled reimbursement group leader personId;
  // separate from legacy groupSize (which changes weights, not identities).
  paymentGroupRepresentativeId?: string;
  // Server-only bounded record of delegated actions; never serialize this
  // (or the actor's private token) into the public receipt or claim payload.
  delegatedReceiptAudit?: {
    actorId: string;
    targetId: string;
    action: 'claim-items' | 'item-parts' | 'personal-tip';
    at: string;
    itemIndex?: number;
  }[];
  // Voluntary tip personally chosen for this receipt, integer RUB kopecks; missing = 0.
  tipCents?: number;
  // Participant's declaration only; does NOT mean funds arrived or were verified.
  paymentDeclaredAt?: string;
  // Exact finalized receipt debt/group debt in kopecks, captured by the server at declaration time.
  // Never accept a caller-provided amount; never expose this private record on a public receipt.
  paymentDeclaredAmountCents?: number;
  // The latest explicit retraction of "I paid". Private to the payer review;
  // survives reconnects even if the participant later declares again.
  paymentUnmarkedAt?: string;
  // 5.18: bounded action-key history prevents a delayed retry from re-marking
  // a revoked declaration or revoking a later, distinct declaration.
  paymentDeclarationActionRequests?: {
    id: string;
    action: 'mark' | 'unmark';
    at: string;
  }[];
  // Payer's independent verification after checking actual incoming funds.
  paymentVerifiedAt?: string;
  // Private audit: stable personId of the actual payer who confirmed this transfer, never a display name.
  paymentVerifiedByPersonId?: string;
  // 5.16: bounded, private receipt-status action history, used to reject a
  // delayed HTTP retry after a newer explicit confirm/cancel has committed.
  // A key denotes ONE payer tap, not the current mutable status.
  paymentReceiptStatusRequests?: {
    id: string;
    action: 'confirm' | 'cancel';
    at: string;
  }[];
  // Private per-person push endpoints; never expose to public getSession/getSplit.
  // Only the sender of a grouped payment can subscribe for that transfer.
  guestPushSubscriptions?: GuestWebPushSubscription[];
  // 5.11: one receipt-confirmation notification per reimbursed transfer.
  // Saved atomically with payer verification, exclusively on its actual sender.
  // Guest identity and read state persist with the receipt even when offline.
  paymentReceiptNotification?: {
    id: string;
    payerName: string;
    amountCents: number;
    receiptName: string;
    confirmedAt: string;
    readAt?: string;
  };
  // Payer-retracted receipt acknowledgements are separate addressed events,
  // retained for a guest returning after the phone was offline. Bounded list.
  paymentReceiptCancellationNotifications?: {
    id: string;
    // Immutable actor identity recorded at the time of the retraction.
    // Older pre-5.15 receipt events have only a payerName.
    payerPersonId?: string;
    payerName: string;
    amountCents: number;
    receiptName: string;
    cancelledAt: string;
    readAt?: string;
  }[];
  // The join that created (or first claimed) this person: its idempotency key and the normalized
  // name it was made with, replayable until expiresAt (epoch ms). See guest.joinSession.
  join?: { key: string; name: string; expiresAt: number };
  // The last saves this person's token sent to guest.claimItems with a save key: the key and a
  // digest of the changes, so a retry of a save whose answer was lost isn't applied twice (#238).
  // Read through validSaveRecords (json-schemas.ts), which skips malformed records.
  saves?: { key: string; hash: string }[];
  // Distinct from claimItems saves: an acknowledged personal-parts set may
  // be repeated after a network timeout even if this guest edited it again.
  // Store the operation digest on the authenticated person, not the dish.
  personalPartSaves?: { key: string; hash: string }[];
};

export type IdentifiedGuestPerson = GuestSessionPerson & { id: string };

// An id that isn't a UUID counts as missing: no request could name that person
export function hasPersonIds(people: readonly GuestSessionPerson[]): people is IdentifiedGuestPerson[] {
  return people.every((p) => isPersonId(p.id));
}

/** The people with an id each: anyone without a valid one gets a new random id. */
export function assignPersonIds(
  people: readonly GuestSessionPerson[],
  newId: () => string = randomUUID,
): IdentifiedGuestPerson[] {
  return people.map((p) => (isPersonId(p.id) ? { ...p, id: p.id } : { ...p, id: newId() }));
}

/**
 * The index of the person a request targets, by their id, wherever that person is now (an index
 * could name whoever moved into that place after someone listed earlier was removed, #225).
 * -1 when nobody has the id, e.g. the person was removed.
 */
export function findTargetIndex(people: readonly { id?: string | undefined }[], id: string): number {
  return people.findIndex((p) => p.id === id);
}
