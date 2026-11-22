import { GUEST_OWNER_COLOR_ID, GUEST_PALETTE_V2_BASE } from '@/lib/guest-visual-color';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { AppError } from '@/server/lib/app-error';
import { isAllowedRegistrationEmailDomain } from '@/server/lib/registration-email-domain';
import { Prisma, GuestSplitStatus } from '@/generated/prisma/client';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import { logger } from '../../lib/logger';
import { checkTokenRateLimit } from '../../lib/rate-limit';
import {
  checkClaimWriteRateLimit,
  checkSessionReadRateLimit,
  checkGuestPresenceHeartbeatLimit,
} from '../../lib/guest-session-limits';
import { checkGuestReceiptCreationLimit } from '../../lib/guest-receipt-create-limit';
import { guestTransaction } from '../../lib/guest-transaction';
import { issueGuestShareLink, revealGuestShareLink, shareLookupHash } from '../../lib/guest-share-link';
import { issueGuestPersonToken } from '../../lib/guest-person-secret';
import { guestLinkSecretSchema } from '../../lib/guest-link-secret';
import {
  MAX_GUEST_PUSH_SUBSCRIPTIONS,
  activeGuestPushSubscriptions,
  guestPushPublicKey,
  guestPushTokenBinding,
  sendGuestReceiptPush,
  validGuestPushEndpoint,
  validGuestPushSubscription,
  validStoredGuestPushSubscriptions,
} from '../../lib/guest-web-push';
import { deleteExpiredSplits, deleteUnusedSplitReceipts, lockReceiptForSplit } from '../../lib/receipt-cleanup';
import {
  parseExtractedData,
  parseGuestItems,
  parseGuestPeople,
  parseGuestAssignments,
  validSaveRecords,
} from '../../lib/json-schemas';
import { calculateSplitTotals, addPersonalGuestTips, groupSizeWeights } from '@/lib/split-calculator';
import {
  guestPortionAssignments,
  materializeGuestPersonalParts,
  type GuestPortionAssignment,
} from '@/lib/guest-portions';
import { guestPartsConfirmationSnapshot } from '@/lib/guest-parts-confirmation';
import { guestKnownPartsBalance } from '@/lib/guest-known-parts';
import { guestPresenceState } from '@/lib/guest-presence';
import {
  guestSettlementDigest,
  assertGuestSettlementUnchanged,
  assertGuestDeclaredAmountsUnchanged,
} from '../../lib/guest-settlement-lock';
import { hasDuplicateGuestNames, normalizeGuestName } from '@/lib/guest-session';
import { MAX_GUEST_NAME_LENGTH } from '@/lib/guest-name-limit';
import { MAX_MONEY_CENTS } from '@/lib/money';
import { reconcileActualReceiptTransfers, type ReceiptOverpaymentChoice } from '@/lib/actual-receipt-payments';
import {
  aggregateReceiptPaymentGroups,
  receiptPaymentMemberships,
  setReceiptPaymentGroups,
  receiptGroupsRevision,
} from '@/lib/receipt-payment-groups';
import { authorizeReceiptPersonEdit, appendDelegatedReceiptAudit } from '../../lib/guest-group-delegation';
import { normalizeSbpPhone, isSupportedSbpBankId } from '@/lib/sbp-banks';
import { checkJoinRateLimit } from '../../lib/guest-join-limit';
import {
  assignPersonIds,
  newGuestPersonId,
  findTargetIndex,
  hasPersonIds,
  personIdSchema,
  type GuestSessionPerson,
  type IdentifiedGuestPerson,
} from '../../lib/guest-people';

/** 3.6.1: the owner's verified server account, never the supplied display name
 * or an impersonated session. OwnerBootstrap is the single source of owner
 * identity; matching ADMIN_EMAIL or choosing the same name never grants it.
 * Activation is restricted to the configured owner's profile name «Илья».
 */
const RESERVED_OWNER_NAME = 'Илья';
const RESERVED_OWNER_KEY = normalizeGuestName(RESERVED_OWNER_NAME);

async function billokOwnerUserId(ctx: {
  session?: { user?: { id?: string | null } | null } | null;
  impersonating?: unknown;
  db: typeof import('@/server/db').db;
}): Promise<string | null> {
  const userId = ctx.session?.user?.id;
  if (!userId || ctx.impersonating) return null;
  const owner = await ctx.db.ownerBootstrap.findUnique({
    where: { id: 1 },
    select: { userId: true, completedAt: true },
  });
  if (!owner?.completedAt || owner.userId !== userId) return null;
  const account = await ctx.db.user.findUnique({
    where: { id: userId },
    select: { name: true, suspendedAt: true },
  });
  return account && normalizeGuestName(account.name ?? '') === RESERVED_OWNER_KEY && !account.suspendedAt
    ? userId
    : null;
}

/** Rename only the colliding display label, never the underlying token,
 * account binding or any shares. Call exclusively inside guestTransaction.
 */
function freeOwnerName(people: IdentifiedGuestPerson[], ownerIndex: number): boolean {
  const occupied = new Set(people.map((person) => normalizeGuestName(person.name)));
  let changed = false;
  for (let i = 0; i < people.length; i++) {
    if (i === ownerIndex || normalizeGuestName(people[i]!.name) !== RESERVED_OWNER_KEY) continue;
    let suffix = 2;
    let candidate = `${RESERVED_OWNER_NAME} (${suffix})`;
    while (occupied.has(normalizeGuestName(candidate))) {
      suffix++;
      candidate = `${RESERVED_OWNER_NAME} (${suffix})`;
    }
    occupied.add(normalizeGuestName(candidate));
    people[i] = { ...people[i]!, name: candidate };
    changed = true;
  }
  return changed;
}

/** Clear an organizer's acknowledgement only for sessions with a saved one.
 * No extra JSON writes for unchanged/legacy sessions or personal tip updates.
 */
function invalidatePartsApproval(value: Prisma.JsonValue): { receiptData?: Prisma.InputJsonValue } {
  const data = parseExtractedData(value);
  if (!data.partsApprovalHash) return {};
  const next = { ...data };
  delete next.partsApprovalHash;
  return { receiptData: next as Prisma.InputJsonValue };
}

function guestPartsDigest(input: {
  items: readonly { name: string; quantity: number; totalPrice: number }[];
  people: readonly { id?: string | undefined; groupSize?: number | undefined }[];
  assignments: readonly GuestPortionAssignment[];
  knownPartsByItem?: unknown;
}): string {
  return createHash('sha256').update(guestPartsConfirmationSnapshot(input)).digest('hex');
}

/** Financial revision for the one-step finalization dialog. No credentials or
 * subscription endpoints are included. The same fields are checked under the
 * finalization transaction lock, including tips, payer and reimbursement groups.
 */
function guestFinalizationRevision(input: {
  items: Parameters<typeof guestPartsDigest>[0]['items'];
  people: readonly GuestSessionPerson[];
  assignments: readonly GuestPortionAssignment[];
  receiptData: ReturnType<typeof parseExtractedData>;
  paidByIndex: number;
}): string {
  const data = input.receiptData;
  return createHash('sha256')
    .update(
      JSON.stringify({
        parts: guestPartsDigest({ ...input, knownPartsByItem: data.knownPartsByItem }),
        people: input.people.map((p) => [p.id, p.name, p.tipCents ?? 0, p.paymentGroupRepresentativeId ?? null]),
        payer: input.paidByIndex,
        payerRevision: data.payerRevision ?? null,
        total: [data.subtotal, data.tax, data.tip, data.total, data.currency, data.roundingBalanced ?? false],
        author: data.organizerPersonId ?? null,
        delegate: data.finalizationOrganizerUserId ?? null,
      }),
    )
    .digest('hex');
}

/** 3.4: a signed-in creator or a single creator-appointed registered organizer can
 * approve and finalize a guest bill. A payer/guest token never grants this role.
 * Store the delegation in the existing receipt JSON: no unused DB column.
 */
function canFinalizeGuestSession(
  creatorUserId: string | null | undefined,
  data: ReturnType<typeof parseExtractedData>,
  callerUserId: string | null | undefined,
): boolean {
  return (
    !!creatorUserId &&
    !!callerUserId &&
    (creatorUserId === callerUserId || data.finalizationOrganizerUserId === callerUserId)
  );
}

/** 2.20.2: known totals are optional, but strict where provided.
 * All checks happen in guestTransaction using its current data snapshot.
 */
function enforceGuestKnownParts(
  items: readonly unknown[],
  people: readonly { id?: string | undefined; groupSize?: number | undefined }[],
  assignments: readonly GuestPortionAssignment[],
  rawKnown: unknown,
  requireComplete: boolean,
) {
  let state: ReturnType<typeof guestKnownPartsBalance>;
  try {
    state = guestKnownPartsBalance({ items, people, assignments, knownPartsByItem: rawKnown });
  } catch {
    throw new AppError('BAD_REQUEST', 'invalidData', { label: 'known original portions' });
  }
  if (state.overclaimed) throw new AppError('PRECONDITION_FAILED', 'receiptKnownPartsOverclaimed');
  if (requireComplete && state.hasRemaining) {
    throw new AppError('PRECONDITION_FAILED', 'receiptKnownPartsRemaining');
  }
  return state;
}

// How long a join can be replayed with its join key (Stripe prunes idempotency keys once they are at least 24 hours old)
const JOIN_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

// The most people a claim session holds
const MAX_SESSION_PEOPLE = 100;

function toPublicPerson({
  name,
  groupSize,
  personToken,
  accountUserId,
  visualColorId,
  reservedOwner,
}: GuestSessionPerson) {
  // Public receipts never expose personal tokens or account identifiers.
  // An account-bound creator is occupied even if device storage was unavailable
  // when the receipt was created and there is no guest token yet.
  return {
    name,
    // Only an actual legacy persisted weight >1 remains visible to old
    // financial summaries. New receipts have no groupSize field at all.
    ...(groupSize != null && groupSize > 1 ? { groupSize } : {}),
    hasJoined: !!personToken || !!accountUserId,
    // Only a trusted server-issued account binding qualifies, not a display
    // name, phone, share URL, or possession of a guest bearer credential.
    isRegistered: typeof accountUserId === 'string' && accountUserId.length > 0,
    // Publish only the harmless palette selector, never the server-only owner marker
    // or account id. The owner identity was authenticated when reservedOwner was saved.
    ...(reservedOwner && accountUserId
      ? { visualColorId: GUEST_OWNER_COLOR_ID }
      : Number.isSafeInteger(visualColorId) && visualColorId! >= 0
        ? { visualColorId }
        : {}),
  };
}

function toPublicPeople(people: GuestSessionPerson[]) {
  return people.map(toPublicPerson);
}

// The claim page's view of the people: public fields plus each person's id, which it uses to
// target them (their index changes when someone listed before them is removed)
/** 3.8.1: the shared invite and the slot claim alone are not a saved
 * personal action. Mark eligibility only in the same successful transaction
 * as a real change authored by this guest's own personal token. */
function markPersonalLinkReady(person: GuestSessionPerson): GuestSessionPerson {
  return person.guestSlotNumber !== undefined && !!person.personToken && !person.personalLinkReadyAt
    ? { ...person, personalLinkReadyAt: new Date().toISOString() }
    : person;
}

function toClaimPeople(people: IdentifiedGuestPerson[]) {
  return people.map((person) => ({
    id: person.id,
    ...toPublicPerson(person),
    // Fixed slot number is safe and necessary for the shared-link UI. The
    // accountUserId and reservedOwner marker remain server-only.
    ...(person.guestSlotNumber !== undefined
      ? {
          guestSlotNumber: person.guestSlotNumber,
          personalLinkReady: !!person.personalLinkReadyAt,
        }
      : {}),
    tipCents: person.tipCents ?? 0,
    ...(person.paymentGroupRepresentativeId !== undefined
      ? { paymentGroupRepresentativeId: person.paymentGroupRepresentativeId }
      : {}),
  }));
}

/**
 * Gives people saved without an id their ids, once, and returns the session as read in that
 * transaction (so its people and assignments are from the same moment). Keeps any ids another
 * request saved first.
 */
async function savePersonIds(db: typeof import('@/server/db').db, sessionId: string) {
  return guestTransaction(db, async (tx) => {
    const session = await tx.guestSplit.findUnique({ where: { id: sessionId } });
    if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
    const current = session.people as GuestSessionPerson[];
    if (hasPersonIds(current)) return session;
    const people = assignPersonIds(current);
    await tx.guestSplit.update({
      where: { id: sessionId },
      data: { people: people as unknown as Prisma.InputJsonValue },
    });
    return { ...session, people: people as unknown as Prisma.JsonValue };
  });
}

/** A claimItems request sends either the person's whole claim set, or the items added and removed. */
function claimsOneWay(claimed: number[] | undefined, added: number[] | undefined, removed: number[] | undefined) {
  return (claimed !== undefined) !== (added !== undefined || removed !== undefined);
}
const CLAIMS_ONE_WAY = { message: 'Send either the whole claim set or the items added and removed' };

function addsAndRemovesApart(added: number[] | undefined, removed: number[] | undefined) {
  const removedSet = new Set(removed);
  return !(added ?? []).some((idx) => removedSet.has(idx));
}
const ADD_OR_REMOVE = { message: 'An item cannot be both added and removed' };

// Legacy claimItems retains idempotency keys for older clients.
// Per-dish writes use independent itemAllocationSaves in setReceiptItemParts.
// Bound the retained legacy keys to keep shared JSON compact.
const SAVE_KEYS_KEPT = 10;

/**
 * A digest of what a claimItems request changes, kept with its save key: a retry must send the
 * same changes as the save it retries (like a join key's name). Item order doesn't matter. The
 * first 96 bits of a SHA-256 are plenty to tell a caller's own requests apart, and keep the
 * record small.
 */
function claimChangesHash(input: {
  personId: string;
  claimedItemIndices?: number[] | undefined;
  addItemIndices?: number[] | undefined;
  removeItemIndices?: number[] | undefined;
}): string {
  const sorted = (indices: number[] | undefined) => (indices ? [...new Set(indices)].sort((a, b) => a - b) : null);
  const changes = [
    input.personId,
    sorted(input.claimedItemIndices),
    sorted(input.addItemIndices),
    sorted(input.removeItemIndices),
  ];
  return createHash('sha256').update(JSON.stringify(changes)).digest('base64url').slice(0, 16);
}

/** The items a person has claimed that someone else has claimed too, with their names. */
function claimConflicts(
  assignments: { itemIndex: number; personIndices: number[] }[],
  people: GuestSessionPerson[],
  personIndex: number,
) {
  const conflicts: { itemIndex: number; claimedBy: string[] }[] = [];
  for (const { itemIndex, personIndices } of assignments) {
    if (!personIndices.includes(personIndex)) continue;
    const otherNames = personIndices.filter((pi) => pi !== personIndex).map((pi) => people[pi]?.name ?? 'Someone');
    if (otherNames.length > 0) conflicts.push({ itemIndex, claimedBy: otherNames });
  }
  return conflicts;
}

/**
 * A share token as sent by the client. Real ones are 25-character cuids; the cap bounds the
 * rate-limit keys built from a token before the session is looked up (a made-up token makes a
 * new key on every request), without a database read in front of the limiter (#208).
 */
const shareTokenSchema = z.string().max(64);
/** A receipt id as sent by the client: a cuid, capped like a share token (getReceiptItems builds a limiter key from it). */
const receiptIdSchema = z.string().max(64);

/** The index of the person a request targets by id (see findTargetIndex); CONFLICT when they're gone. */
function targetIndexOrThrow(people: readonly { id?: string | undefined }[], id: string): number {
  const found = findTargetIndex(people, id);
  if (found >= 0) return found;
  // Removed since the caller last loaded the session
  throw new AppError('CONFLICT', 'personGone');
}

/** Stable digest of a personal portion SET, not a delta. A key may be
 * resent only with precisely the same target dish, person and final amount.
 * These records live in their own namespace, separate from claimItems.
 */
function personalPartsSaveHash(input: { personId: string; itemIndex: number; parts: number }): string {
  return createHash('sha256')
    .update(JSON.stringify([input.personId, input.itemIndex, input.parts]))
    .digest('base64url')
    .slice(0, 16);
}

function cloneAssignments(assignments: GuestPortionAssignment[]) {
  return assignments.map((assignment) => ({
    ...assignment,
    personIndices: [...assignment.personIndices],
    ...(assignment.partsByPersonId ? { partsByPersonId: { ...assignment.partsByPersonId } } : {}),
  }));
}

/**
 * A finalized receipt contains one group debt for every reimbursement
 * representative. Its individual row totals are immutable: group money is a
 * computed view, not new money and never a separate transfer per member.
 * Existing non-grouped receipts retain the original payment protocol.
 */
function finalizedPaymentGroups(
  people: GuestSessionPerson[],
  paidByIndex: number,
  summary: { personIndex: number; total: number; tip: number }[],
  receiptTotal: number,
) {
  if (!people.some((person) => person.paymentGroupRepresentativeId !== undefined)) return null;
  try {
    return aggregateReceiptPaymentGroups(people, paidByIndex, summary, receiptTotal).groups;
  } catch {
    throw new AppError('FORBIDDEN', 'invalidPersonToken');
  }
}

/** Validate the stored settlement without rewriting it. Ordinary receipts
 * intentionally omit people who consumed nothing; grouped receipts have a
 * complete ledger. A missing row is not a debt and must never confer access.
 * Before permitting a sparse historical ledger, prove every omitted person
 * has no saved claim, tip, or payment history. The original checksum and
 * declared amounts are checked by the callers against the unmodified rows.
 */
function requireFinalizedPaymentSummary(
  split: {
    people: Prisma.JsonValue;
    paidByIndex: number;
    receiptData: Prisma.JsonValue;
    summary: Prisma.JsonValue | null;
    assignments?: Prisma.JsonValue;
  },
  people: GuestSessionPerson[],
) {
  const receipt = split.receiptData as { currency?: string; tax?: number; tip?: number; total?: number };
  const summary = split.summary as { personIndex: number; total: number; tip: number }[] | null;
  const denied = () => new AppError('FORBIDDEN', 'invalidPersonToken');
  if (
    receipt.currency !== 'RUB' ||
    receipt.tax !== 0 ||
    receipt.tip !== 0 ||
    !Number.isSafeInteger(receipt.total) ||
    receipt.total! < 0 ||
    !Array.isArray(summary) ||
    summary.length === 0 ||
    summary.length > people.length ||
    !people[split.paidByIndex] ||
    summary.some(
      (entry) =>
        !entry ||
        !Number.isSafeInteger(entry.personIndex) ||
        entry.personIndex < 0 ||
        entry.personIndex >= people.length ||
        !Number.isSafeInteger(entry.total) ||
        entry.total < 0 ||
        !Number.isSafeInteger(entry.tip) ||
        entry.tip < 0 ||
        entry.tip > entry.total,
    ) ||
    new Set(summary.map((entry) => entry.personIndex)).size !== summary.length ||
    summary.reduce((sum, entry) => sum + entry.total, 0) !==
      receipt.total! + summary.reduce((sum, entry) => sum + entry.tip, 0)
  ) {
    throw denied();
  }

  if (summary.length < people.length) {
    // Grouped settlements require one explicit row for each participant.
    if (
      people.some((person) => person.paymentGroupRepresentativeId !== undefined) ||
      !hasPersonIds(people) ||
      !Array.isArray(split.assignments)
    )
      throw denied();

    const included = new Set(summary.map((entry) => entry.personIndex));
    const parsed = z
      .array(
        z.object({
          itemIndex: z.number().int().min(0),
          personIndices: z.array(
            z
              .number()
              .int()
              .min(0)
              .max(people.length - 1),
          ),
          partsByPersonId: z.record(z.string(), z.number().int().min(1).max(10000)).optional(),
        }),
      )
      .safeParse(split.assignments);
    if (!parsed.success || parsed.data.length === 0) throw denied();
    for (const assignment of parsed.data) {
      if (
        assignment.personIndices.some((index) => !included.has(index)) ||
        Object.keys(assignment.partsByPersonId ?? {}).some(
          (id) => !assignment.personIndices.some((index) => people[index]!.id === id),
        )
      )
        throw denied();
    }
    for (const [index, person] of people.entries()) {
      if (
        !included.has(index) &&
        ((person.tipCents ?? 0) !== 0 ||
          Object.keys(person).some((key) => key.startsWith('payment') || key === 'guestPushSubscriptions'))
      ) {
        throw denied();
      }
    }
  }
  return { receiptTotal: receipt.total!, summary };
}

/** Return only a verified non-payer with a positive, reconciled personal debt.
 * Never authorize using a public share token, creator login or display name.
 */
function requireGuestDebtor(
  split: {
    status: GuestSplitStatus;
    people: Prisma.JsonValue;
    paidByIndex: number;
    receiptData: Prisma.JsonValue;
    summary: Prisma.JsonValue | null;
    assignments?: Prisma.JsonValue;
  },
  personId: string,
  personToken: string,
) {
  if (split.status !== GuestSplitStatus.FINALIZED) {
    throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
  }
  const people = split.people as GuestSessionPerson[];
  const personIndex = people.findIndex((person) => person.id === personId && person.personToken === personToken);
  if (personIndex < 0 || personIndex === split.paidByIndex) {
    throw new AppError('FORBIDDEN', 'invalidPersonToken');
  }
  const person = people[personIndex]!;
  const { receiptTotal, summary } = requireFinalizedPaymentSummary(split, people);
  const paymentGroups = finalizedPaymentGroups(people, split.paidByIndex, summary, receiptTotal);
  assertGuestSettlementUnchanged({
    receiptData: split.receiptData,
    people,
    paidByIndex: split.paidByIndex,
    summary,
    receiptTotalCents: receiptTotal,
  });
  assertGuestDeclaredAmountsUnchanged({
    people,
    paidByIndex: split.paidByIndex,
    summary,
    groupDebts: paymentGroups,
  });
  const group = paymentGroups?.find((entry) => entry.memberIndices.includes(personIndex));
  const due = summary.find((entry) => entry.personIndex === personIndex);
  if (group ? group.totalCents <= 0 : !due || due.total <= 0) {
    throw new AppError('FORBIDDEN', 'invalidPersonToken');
  }
  const paymentIndex =
    group?.memberIndices.find((index) => people[index]!.id === group.representativeId) ?? personIndex;
  return {
    people,
    person,
    personIndex,
    paymentIndex,
    paymentPerson: people[paymentIndex]!,
    amountCents: group ? group.totalCents : due!.total,
    group,
  };
}

/** Check payer's identity and reconcile the finalized receipt before allowing
 * payer-only verification. The public share token and creator account are not authority.
 */
function requireGuestPayerReview(
  split: {
    status: GuestSplitStatus;
    people: Prisma.JsonValue;
    paidByIndex: number;
    receiptData: Prisma.JsonValue;
    summary: Prisma.JsonValue | null;
    assignments?: Prisma.JsonValue;
  },
  payerId: string,
  payerToken: string,
) {
  const people = split.people as GuestSessionPerson[];
  const payer = people[split.paidByIndex];
  if (!payer || payer.id !== payerId || payer.personToken !== payerToken) {
    throw new AppError('FORBIDDEN', 'invalidPersonToken');
  }
  if (split.status !== GuestSplitStatus.FINALIZED) {
    throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
  }
  const { receiptTotal, summary } = requireFinalizedPaymentSummary(split, people);
  const paymentGroups = finalizedPaymentGroups(people, split.paidByIndex, summary, receiptTotal);
  assertGuestSettlementUnchanged({
    receiptData: split.receiptData,
    people,
    paidByIndex: split.paidByIndex,
    summary,
    receiptTotalCents: receiptTotal,
  });
  assertGuestDeclaredAmountsUnchanged({
    people,
    paidByIndex: split.paidByIndex,
    summary,
    groupDebts: paymentGroups,
  });
  return { people, summary, paymentGroups };
}

/** Private payer snapshot: never publish unverified amounts through the shared receipt URL. */
function payerActualReceiptSnapshot(person: GuestSessionPerson, amountCents: number, tipCents: number) {
  const history = person.paymentReceivedTransfers ?? [];
  const computed = reconcileActualReceiptTransfers(
    amountCents,
    tipCents,
    history,
    person.paymentOverpaymentChoice ?? null,
    person.paymentRefunds ?? [],
  );
  // Receipts confirmed before 5.22 did not store a transfer ledger.
  if (history.length === 0 && person.paymentVerifiedAt) {
    return {
      ...computed,
      receivedCents: amountCents,
      appliedToDebtCents: amountCents,
      outstandingCents: 0,
    };
  }
  return computed;
}

// ─── Shared Zod schemas (Finding #27) ────────────────────────────
const receiptDataSchema = z
  .object({
    merchantName: z.string().optional(),
    date: z.string().optional(),
    subtotal: z.number().int(),
    // Item prices include restaurant taxes; personal tips will be separate.
    tax: z.number().int().min(0).max(0).default(0),
    tip: z.number().int().min(0).max(0).default(0),
    total: z.number().int().min(0),
    currency: z.string().trim().toUpperCase().pipe(z.literal('RUB')).default('RUB'),
  })
  .refine((receipt) => receipt.total === receipt.subtotal, {
    path: ['total'],
    message: 'No additional tax or shared tips in a new BillOK receipt',
  });

const itemSchema = z.object({
  name: z.string(),
  quantity: z.number().int().min(1),
  unitPrice: z.number().int(),
  totalPrice: z.number().int(),
});

// ─── Shared helpers (Finding #28) ─────────────────────────────────
/** Create a Date 7 days from now for guest split expiration. */
function createExpiryDate(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  return expiresAt;
}

/** Fire-and-forget cleanup of expired GuestSplit records. */
function cleanupExpiredSplits(db: typeof import('@/server/db').db, logPrefix: string): void {
  // One batch per new split keeps up with expiry; a backlog clears over the next few
  deleteExpiredSplits(db, 100)
    .then((deletedCount) => {
      if (deletedCount > 0) {
        logger.info(`${logPrefix}.cleanup`);
      }
    })
    .catch((err) => {
      logger.warn(`${logPrefix}.cleanup.failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export const guestRouter = createTRPCRouter({
  expireSession: protectedProcedure.input(z.object({ token: shareTokenSchema })).mutation(async ({ ctx, input }) => {
    const session = await ctx.db.guestSplit.findUnique({
      where: { shareToken: shareLookupHash(input.token) },
      select: { id: true, userId: true },
    });
    if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
    if (session.userId !== ctx.user.id) throw new AppError('NOT_FOUND', 'sessionNotFound');
    await ctx.db.guestSplit.update({
      where: { id: session.id },
      data: { expiresAt: new Date(0) },
    });
    return { success: true };
  }),

  deleteSplit: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const split = await ctx.db.guestSplit.findUnique({
      where: { id: input.id },
      select: { userId: true, receiptId: true },
    });
    if (!split || split.userId !== ctx.user.id) {
      throw new AppError('NOT_FOUND', 'splitNotFound');
    }
    // Its receipt goes too, unless a group or another split still uses it (#265)
    await ctx.db.$transaction(async (tx) => {
      await tx.guestSplit.delete({ where: { id: input.id } });
      return deleteUnusedSplitReceipts(tx, split.receiptId ? [split.receiptId] : []);
    });
    return { success: true };
  }),

  mySplits: protectedProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const splits = await ctx.db.guestSplit.findMany({
        where: { userId: ctx.user.id },
        orderBy: { createdAt: 'desc' },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
      });

      let nextCursor: string | undefined;
      if (splits.length > input.limit) {
        nextCursor = splits.pop()!.id;
      }

      type ReceiptJson = Record<string, unknown>;
      type PersonJson = Record<string, unknown>;

      return {
        splits: splits.map((s) => {
          const receipt = s.receiptData as ReceiptJson | null;
          const people = s.people as PersonJson[] | null;
          const items = s.items as PersonJson[] | null;
          return {
            id: s.id,
            shareToken: revealGuestShareLink(s),
            status: s.status,
            merchantName: receipt?.merchantName as string | undefined,
            total: receipt?.total as number | undefined,
            currency: (receipt?.currency as string | undefined) ?? 'RUB',
            peopleCount: people?.length ?? 0,
            itemCount: items?.length ?? 0,
            createdAt: s.createdAt,
          };
        }),
        nextCursor,
      };
    }),

  getReceiptItems: publicProcedure.input(z.object({ receiptId: receiptIdSchema })).query(async ({ ctx, input }) => {
    // Rate limit: 10 lookups per receipt per hour to mitigate enumeration.
    // Guest receipt IDs are CUIDs (25 chars of randomness) making brute force
    // infeasible, but rate limiting adds defense-in-depth.
    const { allowed } = checkTokenRateLimit(`guest-items:${input.receiptId}`, 10, 60 * 60 * 1000);
    if (!allowed) {
      throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequestsLater');
    }

    const receipt = await ctx.db.receipt.findUnique({
      where: { id: input.receiptId },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!receipt) {
      throw new AppError('NOT_FOUND', 'receiptNotFound');
    }
    if (!receipt.isGuest) {
      throw new AppError('NOT_FOUND', 'receiptNotFound');
    }

    return {
      receipt: {
        id: receipt.id,
        status: receipt.status,
        extractedData: receipt.extractedData as {
          merchantName?: string;
          date?: string;
          subtotal: number;
          tax: number;
          tip: number;
          total: number;
          currency: string;
        } | null,
      },
      items: receipt.items,
    };
  }),

  // The historical finalized-split reader below stays available for saved
  // receipts. The obsolete direct-finalized creation mutation is intentionally
  // absent: new receipts must use createClaimSession and the claim workflow.

  getSplit: publicProcedure.input(z.object({ token: shareTokenSchema })).query(async ({ ctx, input }) => {
    // Bound share-link lookups before PostgreSQL, including invented tokens.
    if (!checkTokenRateLimit(`guest-finalized-read:${input.token}`, 600, 60_000).allowed) {
      throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
    }
    const split = await ctx.db.guestSplit.findUnique({
      where: { shareToken: shareLookupHash(input.token) },
    });
    if (!split) {
      throw new AppError('NOT_FOUND', 'splitNotFound');
    }
    const guestLinkExpired = split.expiresAt < new Date();
    if (guestLinkExpired) {
      // Guest links expire; only the active registered creator may view their
      // finalized receipt afterward through their own account history.
      if (split.status !== GuestSplitStatus.FINALIZED || !split.userId || split.userId !== ctx.session?.user?.id) {
        throw new AppError('NOT_FOUND', 'splitExpired');
      }
      const creator = await ctx.db.user.findUnique({
        where: { id: split.userId },
        select: { suspendedAt: true },
      });
      if (!creator || creator.suspendedAt) throw new AppError('NOT_FOUND', 'splitExpired');
    }
    if (split.status !== GuestSplitStatus.FINALIZED) {
      throw new AppError('CONFLICT', 'splitNotFinalized');
    }
    assertGuestSettlementUnchanged({
      receiptData: split.receiptData,
      people: split.people as GuestSessionPerson[],
      paidByIndex: split.paidByIndex,
      summary: (split.summary ?? []) as { personIndex: number; total: number; tip: number }[],
      receiptTotalCents: (split.receiptData as { total: number }).total,
    });

    return {
      id: split.id,
      shareToken: input.token,
      receiptData: (() => {
        const {
          finalizationOrganizerUserId: _privateOrganizer,
          paymentSettlementLock: _privateSettlement,
          ...visible
        } = parseExtractedData(split.receiptData);
        void _privateOrganizer;
        void _privateSettlement;
        return visible;
      })() as {
        merchantName?: string;
        date?: string;
        subtotal: number;
        tax: number;
        tip: number;
        total: number;
        currency: string;
        roundingBalanced?: boolean;
        organizerPersonId?: string;
      },
      items: split.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[],
      people: toPublicPeople(split.people as GuestSessionPerson[]),
      organizerIndex: (() => {
        const organizerPersonId = (split.receiptData as { organizerPersonId?: string }).organizerPersonId;
        return typeof organizerPersonId === 'string'
          ? (split.people as GuestSessionPerson[]).findIndex((person) => person.id === organizerPersonId)
          : -1;
      })(),
      assignments: guestPortionAssignments(
        split.assignments as GuestPortionAssignment[],
        split.people as GuestSessionPerson[],
      ),
      summary: split.summary as {
        personIndex: number;
        name: string;
        itemTotal: number;
        tax: number;
        tip: number;
        total: number;
        roundingCorrectionCents?: number;
      }[],
      paidByIndex: split.paidByIndex,
      isCreator: !!split.userId && split.userId === ctx.session?.user?.id,
      archivedCreatorView: guestLinkExpired,
      isPayer: (() => {
        if (!ctx.session?.user?.name) return false;
        const people = split.people as GuestSessionPerson[];
        const payerName = people[split.paidByIndex]?.name;
        return !!payerName && normalizeGuestName(ctx.session.user.name) === normalizeGuestName(payerName);
      })(),
      createdAt: split.createdAt,
      expiresAt: split.expiresAt,
    };
  }),

  // ─── CLAIMING SESSION ENDPOINTS ────────────────────────────

  createClaimSession: protectedProcedure
    .input(
      z.object({
        receiptId: receiptIdSchema.optional(),
        receiptData: receiptDataSchema,
        items: z.array(itemSchema).min(1).max(100),
        // Legacy named-person receipts retain their original fields.
        // 3.7.1: new receipts instead specify a fixed number of additional
        // guests and derive the creator's name from their signed-in account.
        creatorName: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH).optional(),
        paidByName: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH).optional(),
        guestCount: z
          .number()
          .int()
          .min(0)
          .max(MAX_SESSION_PEOPLE - 1)
          .optional(),
        paidByGuestSlot: z
          .number()
          .int()
          .min(1)
          .max(MAX_SESSION_PEOPLE - 1)
          .optional(),
        // Everyone typed on "Who's splitting?", listed in this order (#263). The creator and the
        // payer are added when it leaves them out, and a name typed twice is listed once, since
        // people join by name.
        people: z.array(z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH)).max(MAX_SESSION_PEOPLE).optional(),
        // Join the creator now and return their identity, so the creator's device already is them
        // when the link is shared (#263). Opt-in because older clients join the creator by name
        // afterwards, which is refused once someone holds the creator's token.
        joinCreator: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkGuestReceiptCreationLimit(ctx.user.id)) {
        throw new AppError('TOO_MANY_REQUESTS', 'sessionsRateLimited');
      }

      const guestCount = input.guestCount;
      const usingGuestSlots = guestCount !== undefined;
      // The two creation protocols are intentionally mutually exclusive:
      // never reinterpret arbitrary names as identities of unclaimed slots.
      if (usingGuestSlots) {
        if (
          input.people?.length ||
          input.creatorName !== undefined ||
          input.paidByName !== undefined ||
          (input.paidByGuestSlot !== undefined && input.paidByGuestSlot > guestCount)
        ) {
          throw new AppError('BAD_REQUEST', 'invalidData', { label: 'guest slots' });
        }
      } else if (!input.creatorName || !input.paidByName || input.paidByGuestSlot !== undefined) {
        throw new AppError('BAD_REQUEST', 'invalidData', { label: 'guest participants' });
      }
      const ownerId = await billokOwnerUserId(ctx);
      const creatorProfile = usingGuestSlots
        ? await ctx.db.user.findUnique({ where: { id: ctx.user.id }, select: { name: true } })
        : null;
      const creatorName = ownerId
        ? RESERVED_OWNER_NAME
        : usingGuestSlots
          ? (creatorProfile?.name ?? '').normalize('NFC').trim()
          : input.creatorName!.trim();
      if (!creatorName || creatorName.length > MAX_GUEST_NAME_LENGTH) {
        throw new AppError('BAD_REQUEST', 'invalidData', { label: 'creator display name' });
      }
      const paidByName = usingGuestSlots ? creatorName : input.paidByName!.trim();

      // Duplicate guest rows are rejected; creator and payer references
      // intentionally point to the same row when the names match.
      if (hasDuplicateGuestNames(input.people ?? [])) {
        throw new AppError('CONFLICT', 'nameTaken');
      }
      const people: IdentifiedGuestPerson[] = [];
      const mintPersonId = () => newGuestPersonId(people.map((person) => person.id));
      const indexOf = (name: string) =>
        people.findIndex((p) => normalizeGuestName(p.name) === normalizeGuestName(name));
      if (usingGuestSlots) {
        // Always exactly one creator plus guestCount independently addressable
        // slots. The payer is a role on one of these rows, never an extra guest.
        people.push({
          id: mintPersonId(),
          name: creatorName,
          accountUserId: ctx.user.id,
          ...(ownerId ? { reservedOwner: true } : {}),
        });
        for (let slot = 1; slot <= guestCount; slot++) {
          const preferredName = `Гость ${slot}`;
          const name = indexOf(preferredName) < 0 ? preferredName : `${preferredName} (гость)`;
          people.push({ id: mintPersonId(), name, guestSlotNumber: slot });
        }
      } else {
        for (const name of [...(input.people ?? []), creatorName, paidByName]) {
          if (indexOf(name) < 0) people.push({ id: mintPersonId(), name: name.normalize('NFC') });
        }
        if (ownerId) {
          const idx = indexOf(RESERVED_OWNER_NAME);
          people[idx] = { ...people[idx]!, accountUserId: ownerId, reservedOwner: true };
        }
      }
      if (people.length > MAX_SESSION_PEOPLE) {
        throw new AppError('BAD_REQUEST', 'sessionFull', { max: MAX_SESSION_PEOPLE });
      }
      // Assign once, before any names are changed or people can be removed.
      // The key will survive retries, joins, renames and index compaction.
      for (const [index, person] of people.entries()) {
        people[index] = { ...person, visualColorId: GUEST_PALETTE_V2_BASE + index };
      }
      const paidByIndex = usingGuestSlots ? (input.paidByGuestSlot ?? 0) : indexOf(paidByName);
      // A persistent participant ID identifies the creator even if names are
      // edited and the payer is a different person or appears earlier in the list.
      const creatorIndex = usingGuestSlots ? 0 : indexOf(creatorName);
      const organizerPersonId = people[creatorIndex]!.id;

      // The creator's participant row is account-bound even if browser storage
      // is blocked; a shared invitation alone cannot take their row by name.
      let creator: { personId: string; personToken: string; name: string } | null = null;
      if (input.joinCreator) {
        const person = { ...people[creatorIndex]!, personToken: issueGuestPersonToken() };
        people[creatorIndex] = person;
        creator = { personId: person.id, personToken: person.personToken, name: person.name };
      }

      // Auto-split multi-quantity items into individual rows for easier claiming
      const MAX_EXPANDED_ITEMS = 200;
      const totalExpanded = input.items.reduce((sum, item) => sum + Math.max(item.quantity, 1), 0);
      if (totalExpanded > MAX_EXPANDED_ITEMS) {
        throw new AppError('BAD_REQUEST', 'tooManyItems', { count: totalExpanded, max: MAX_EXPANDED_ITEMS });
      }

      const expandedItems: typeof input.items = [];
      for (const item of input.items) {
        if (item.quantity <= 1) {
          expandedItems.push(item);
        } else {
          // Distribute price evenly with round-robin remainder (e.g. $10/3 → $4,$3,$3 not $3,$3,$4)
          const base = Math.floor(item.totalPrice / item.quantity);
          const remainder = item.totalPrice - base * item.quantity;
          for (let i = 0; i < item.quantity; i++) {
            const price = base + (i < remainder ? 1 : 0);
            expandedItems.push({
              name: item.name,
              quantity: 1,
              unitPrice: price,
              totalPrice: price,
            });
          }
        }
      }

      const share = issueGuestShareLink();
      await ctx.db.$transaction(async (tx) => {
        const receiptId = await lockReceiptForSplit(tx, input.receiptId, ctx.session?.user?.id);
        return tx.guestSplit.create({
          data: {
            ...share.stored,
            ...(receiptId !== undefined ? { receiptId } : {}),
            // New personal-link claims use one cross-item rounding strategy.
            // Direct finalized splits keep their historical settlement rules.
            receiptData: {
              ...input.receiptData,
              roundingBalanced: true,
              organizerPersonId,
              ...(usingGuestSlots ? { guestSlotsMode: true, guestCount } : {}),
            } as unknown as Prisma.InputJsonValue,
            items: expandedItems as unknown as Prisma.InputJsonValue,
            people: people as unknown as Prisma.InputJsonValue,
            assignments: [] as unknown as Prisma.InputJsonValue,
            paidByIndex,
            status: GuestSplitStatus.CLAIMING,
            userId: ctx.user.id,
            expiresAt: createExpiryDate(),
          },
        });
      });

      cleanupExpiredSplits(ctx.db, 'guest.session');

      logger.info('guest.session.created');

      return { shareToken: share.token, creator };
    }),

  // TASK-BILLOK-002: expand the guest list without replacing old identities,
  // allocations, settlement state, or the creator/payer. Repeated clicks and
  // network retries with the same request key return the original empty place.
  addGuestPlace: protectedProcedure
    .input(z.object({ token: shareTokenSchema, requestKey: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.impersonating) throw new AppError('FORBIDDEN', 'notParticipant');
      if (!checkTokenRateLimit('guest-creator-add-place:' + ctx.user.id, 30, 60_000).allowed) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: shareLookupHash(input.token) },
        });
        // A share link, a guest token, and a payer are NOT creator authority.
        if (!session || session.userId !== ctx.user.id) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) {
          throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
        }
        const receipt = parseExtractedData(session.receiptData);
        if (receipt.guestSlotsMode !== true) {
          throw new AppError('BAD_REQUEST', 'invalidData', { label: 'guest slots mode' });
        }

        const people = assignPersonIds(session.people as GuestSessionPerson[]);
        const replayed = people.find((person) => person.guestPlaceRequestKey === input.requestKey);
        if (replayed) {
          return { personId: replayed.id, guestSlotNumber: replayed.guestSlotNumber! };
        }
        if (people.length >= MAX_SESSION_PEOPLE) {
          throw new AppError('BAD_REQUEST', 'sessionFull', { max: MAX_SESSION_PEOPLE });
        }

        const slot = Math.max(0, ...people.map((person) => person.guestSlotNumber ?? 0)) + 1;
        let displayName = 'Гость ' + slot;
        let suffix = 2;
        while (people.some((person) => normalizeGuestName(person.name) === normalizeGuestName(displayName))) {
          displayName = 'Гость ' + slot + ' (' + suffix++ + ')';
        }
        const personId = newGuestPersonId(people.map((person) => person.id));
        people.push({
          id: personId,
          name: displayName,
          guestSlotNumber: slot,
          guestPlaceRequestKey: input.requestKey,
          visualColorId: Math.max(-1, ...people.map((person) => person.visualColorId ?? -1)) + 1,
        });
        // Keep the original JSON fields, including private settlement metadata.
        // No changes to assignments, paidByIndex, tips, payments, or tokens.
        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            people: people as unknown as Prisma.InputJsonValue,
            receiptData: {
              ...(session.receiptData as Record<string, unknown>),
              guestCount: slot,
            } as Prisma.InputJsonValue,
          },
        });
        return { personId, guestSlotNumber: slot };
      });
    }),

  /** 3.7.2: join one of N preallocated guest slots by *stable person id*.
   * The shareToken reveals available places but provides no ownership of a
   * taken place. This is intentionally separate from legacy name-based joining.
   * guestTransaction retries conflicting Repeatable Read writes to the same
   * GuestSplit row; both competing requests can never commit the same free slot.
   */
  joinGuestSlot: publicProcedure
    .input(
      z
        .object({
          token: shareTokenSchema,
          // Optional for the shared-link auto-join; an explicit id still selects
          // a specific legacy/preallocated free guest place.
          slotId: personIdSchema.optional(),
          name: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH),
          personToken: guestLinkSecretSchema.optional(),
          joinKey: z.string().uuid().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      // Automatic selection must always be replayable after a lost response.
      if (!input.slotId && !input.joinKey) {
        throw new AppError('BAD_REQUEST', 'invalidData', { label: 'join key' });
      }
      if (!checkJoinRateLimit(input.token, input.name, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      // A verified, active account binds to exactly one row in a receipt. A
      // session created through impersonation is not that account's consent.
      let accountUserId: string | null = null;
      if (ctx.session?.user?.id && !ctx.impersonating) {
        const account = await ctx.db.user.findUnique({
          where: { id: ctx.session.user.id },
          select: { suspendedAt: true },
        });
        if (!account) throw new AppError('UNAUTHORIZED');
        if (account.suspendedAt) throw new AppError('FORBIDDEN', 'accountSuspended');
        accountUserId = ctx.session.user.id;
      }
      const ownerId = accountUserId ? await billokOwnerUserId(ctx) : null;
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
        const receipt = parseExtractedData(session.receiptData);
        if (receipt.guestSlotsMode !== true)
          throw new AppError('BAD_REQUEST', 'invalidData', { label: 'guest slots mode' });
        const stored = session.people as GuestSessionPerson[];
        if (hasDuplicateGuestNames(stored.map((person) => person.name))) {
          throw new AppError('CONFLICT', 'nameTaken');
        }
        const people = assignPersonIds(stored);
        // An automatic link join expands the receipt only after a successful
        // confirmation, not on getSession/read or when the link is opened.
        let addedGuestSlotNumber: number | null = null;
        const save = async () => {
          enforceGuestKnownParts(
            parseGuestItems(session.items),
            people,
            parseGuestAssignments(session.assignments),
            receipt.knownPartsByItem,
            false,
          );
          await tx.guestSplit.update({
            where: { id: session.id },
            data: {
              // Selecting a place changes neither dish portions nor voluntary
              // tip amounts: an already approved allocation stays approved.
              people: people as unknown as Prisma.InputJsonValue,
              ...(addedGuestSlotNumber === null
                ? {}
                : {
                    receiptData: {
                      ...(session.receiptData as Record<string, unknown>),
                      guestCount: Math.max(
                        typeof receipt.guestCount === 'number' ? receipt.guestCount : 0,
                        addedGuestSlotNumber,
                      ),
                    } as Prisma.InputJsonValue,
                  }),
            },
          });
        };
        let targetIndex = people.findIndex((p) => p.id === input.slotId && typeof p.guestSlotNumber === 'number');
        // A registered creator can re-enter their own reserved row using
        // their account, but cannot bind that row to a second guest slot.
        const accountIndex = accountUserId ? people.findIndex((p) => p.accountUserId === accountUserId) : -1;
        const bearerIndex = input.personToken ? people.findIndex((p) => p.personToken === input.personToken) : -1;
        if (bearerIndex >= 0 && people[bearerIndex]!.accountUserId !== (accountUserId ?? undefined)) {
          // A logged-in person cannot silently convert an anonymous personal
          // link, or another registered account's token, into their own place.
          // Explicit account conversion and personal links belong to 3.8.
          throw new AppError('FORBIDDEN', 'notParticipant');
        }
        const existingIndex = accountIndex >= 0 ? accountIndex : bearerIndex;
        if (existingIndex >= 0) {
          // One registered account or previously joined guest retains exactly
          // one position across devices/retries. A token for someone else's
          // guest place never moves a registered account onto it.
          if (accountIndex >= 0 && bearerIndex >= 0 && accountIndex !== bearerIndex) {
            throw new AppError('CONFLICT', 'joinNameTaken');
          }
          const own = people[existingIndex]!;
          if (own.accountUserId && own.accountUserId !== accountUserId) {
            throw new AppError('FORBIDDEN', 'notParticipant');
          }
          const token = own.personToken ?? issueGuestPersonToken();
          const changed = own.personToken !== token;
          if (changed) {
            people[existingIndex] = { ...own, personToken: token };
            await save();
          }
          return { personIndex: existingIndex, personId: own.id, personToken: token, name: own.name };
        }

        // A lost anonymous response can be replayed by a fresh device only
        // with its own unpredictable joinKey; the key is scoped to this exact
        // slot, name, and unauthenticated identity and has a 24h TTL.
        const now = Date.now();
        const replayIndex = input.joinKey
          ? people.findIndex((p) => p.join?.key === input.joinKey && (p.join?.expiresAt ?? 0) > now)
          : -1;
        if (replayIndex >= 0) {
          const replayed = people[replayIndex]!;
          if (
            (input.slotId !== undefined && replayed.id !== input.slotId) ||
            replayed.join!.name !== normalizeGuestName(input.name) ||
            replayed.accountUserId !== undefined ||
            accountUserId !== null
          ) {
            throw new AppError('CONFLICT', 'joinKeyReused');
          }
          return {
            personIndex: replayIndex,
            personId: replayed.id,
            personToken: replayed.personToken!,
            name: replayed.name,
          };
        }

        if (input.slotId === undefined) {
          // The shared link is valid even when all originally created slots
          // have been occupied. Take an existing free slot first. When none
          // remains, append the next independent slot inside this exact
          // Repeatable Read transaction (serializing concurrent joins).
          targetIndex = people.findIndex((p) => p.guestSlotNumber !== undefined && !p.personToken && !p.accountUserId);
          if (targetIndex < 0) {
            if (people.length >= MAX_SESSION_PEOPLE) {
              throw new AppError('BAD_REQUEST', 'sessionFull', { max: MAX_SESSION_PEOPLE });
            }
            const nextSlot = Math.max(0, ...people.map((p) => p.guestSlotNumber ?? 0)) + 1;
            let placeholderName = 'Гость ' + nextSlot;
            let suffix = 2;
            while (people.some((p) => normalizeGuestName(p.name) === normalizeGuestName(placeholderName))) {
              placeholderName = 'Гость ' + nextSlot + ' (' + suffix++ + ')';
            }
            people.push({
              id: newGuestPersonId(people.map((p) => p.id)),
              name: placeholderName,
              guestSlotNumber: nextSlot,
              visualColorId: Math.max(-1, ...people.map((p) => p.visualColorId ?? -1)) + 1,
            });
            addedGuestSlotNumber = nextSlot;
            targetIndex = people.length - 1;
          }
        }
        if (targetIndex < 0) throw new AppError('CONFLICT', 'personGone');
        const target = people[targetIndex]!;
        if (target.personToken || target.accountUserId) {
          throw new AppError('CONFLICT', 'guestSlotTaken');
        }

        // Owner can use only their own verified name. If another diner had
        // that name first, rename just their label, keeping ID/token/shares.
        if (ownerId) freeOwnerName(people, targetIndex);
        const displayName = ownerId ? RESERVED_OWNER_NAME : input.name.normalize('NFC').trim();
        const wanted = normalizeGuestName(displayName);
        if (people.some((p, i) => i !== targetIndex && normalizeGuestName(p.name) === wanted))
          throw new AppError('CONFLICT', 'nameTaken');
        const token = issueGuestPersonToken();
        const newJoin = input.joinKey
          ? {
              join: {
                key: input.joinKey,
                name: normalizeGuestName(input.name),
                expiresAt: now + JOIN_REPLAY_WINDOW_MS,
              },
            }
          : {};
        people[targetIndex] = {
          ...target,
          name: displayName,
          personToken: token,
          ...(accountUserId ? { accountUserId } : {}),
          ...(ownerId ? { reservedOwner: true } : {}),
          ...newJoin,
        };
        await save();
        return { personIndex: targetIndex, personId: target.id, personToken: token, name: displayName };
      });
    }),

  joinSession: publicProcedure
    .input(
      z
        .object({
          token: shareTokenSchema,
          name: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH),
          // The token this device stored when it joined: whoever holds it is the caller. Only ever
          // used to find its holder, never given to anyone, so a removed person's old token
          // can't be attached to someone new.
          personToken: guestLinkSecretSchema.optional(),
          // An idempotency key the device made for this join. Replayable like Stripe's
          // Idempotency-Key: saved (with the normalized name) on the person the join creates or
          // first claims, a replay with the same key and name within JOIN_REPLAY_WINDOW_MS returns
          // that person, so a join whose response was lost doesn't end up at a taken name; the same
          // key with another name is refused. Tokens themselves are always minted here.
          joinKey: z.string().uuid().optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkJoinRateLimit(input.token, input.name, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const ownerId = await billokOwnerUserId(ctx);
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: shareLookupHash(input.token) },
        });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
        // 3.7.1 is the creation protocol only. Until 3.7.2 adds atomic
        // selection by stable slot id, a legacy name-based join must not
        // append arbitrary people or seize a fixed guest place.
        if (parseExtractedData(session.receiptData).guestSlotsMode === true) {
          throw new AppError('BAD_REQUEST', 'invalidData', { label: 'guest slot selection required' });
        }

        const stored = session.people as GuestSessionPerson[];
        // Never assign a claimant to an ambiguous legacy duplicate name.
        if (hasDuplicateGuestNames(stored.map((p) => p.name))) {
          throw new AppError('CONFLICT', 'nameTaken');
        }
        // People saved without an id get theirs now, and are saved even when the join changes
        // nothing else, so the id returned is the one getSession lists. Done here rather than
        // with savePersonIds, so it's one write in this transaction with the join's own changes.
        const idsMissing = !hasPersonIds(stored);
        const people = assignPersonIds(stored);
        const savePeople = () => {
          enforceGuestKnownParts(
            parseGuestItems(session.items),
            people,
            parseGuestAssignments(session.assignments),
            parseExtractedData(session.receiptData).knownPartsByItem,
            false,
          );
          return tx.guestSplit.update({
            where: { id: session.id },
            data: {
              people: people as unknown as Prisma.InputJsonValue,
              ...invalidatePartsApproval(session.receiptData),
            },
          });
        };
        const normalizedName = normalizeGuestName(input.name);
        const holderIndex = input.personToken ? people.findIndex((p) => p.personToken === input.personToken) : -1;

        if (ownerId) {
          // Recover only the account-bound owner row. A guest personal token
          // must NOT implicitly convert some other diner's place into the
          // owner's account; explicit conversion belongs to 3.8.
          const ownIndex = people.findIndex((p) => p.accountUserId === ownerId);
          if (ownIndex < 0 && people.length >= MAX_SESSION_PEOPLE) {
            throw new AppError('BAD_REQUEST', 'sessionFull', { max: MAX_SESSION_PEOPLE });
          }
          const renamedAnother = freeOwnerName(people, ownIndex);
          const previous = ownIndex >= 0 ? people[ownIndex]! : null;
          const personToken = previous?.personToken ?? issueGuestPersonToken();
          const finalIndex = ownIndex >= 0 ? ownIndex : people.length;
          if (previous) {
            people[ownIndex] = {
              ...previous,
              name: RESERVED_OWNER_NAME,
              accountUserId: ownerId,
              reservedOwner: true,
              personToken,
            };
          } else {
            people.push({
              id: newGuestPersonId(people.map((person) => person.id)),
              name: RESERVED_OWNER_NAME,
              accountUserId: ownerId,
              reservedOwner: true,
              personToken,
            });
          }
          // Don't revoke an organizer's approved parts snapshot just because
          // the same account reopened the receipt on another device.
          if (
            !previous ||
            renamedAnother ||
            idsMissing ||
            previous.name !== RESERVED_OWNER_NAME ||
            !previous.personToken
          )
            await savePeople();
          const owner = people[finalIndex]!;
          return { personIndex: finalIndex, personId: owner.id, personToken, name: RESERVED_OWNER_NAME };
        }

        // Once the owner actually participates in this receipt, the reserved
        // name may never be claimed by another account or guest.
        const ownerIndex = people.findIndex(
          (p) => p.reservedOwner === true && normalizeGuestName(p.name) === RESERVED_OWNER_KEY,
        );
        if (ownerIndex >= 0 && normalizedName === RESERVED_OWNER_KEY && holderIndex !== ownerIndex) {
          throw new AppError('CONFLICT', 'nameTaken');
        }

        // The caller already is someone, by the token their device stored: return them under their
        // current name (anyone may have renamed them), whatever name was typed. Checked before a
        // join-key replay, so the device's current identity wins (e.g. another tab joined meanwhile).
        if (holderIndex >= 0) {
          const holder = people[holderIndex]!;
          // No new write may update the weight on a historical receipt.
          if (idsMissing) await savePeople();
          return { personIndex: holderIndex, personId: holder.id, personToken: holder.personToken!, name: holder.name };
        }

        // A replay of a join that already went through: the same person, unchanged
        const now = Date.now();
        const replayIndex = input.joinKey
          ? people.findIndex((p) => !!p.join && p.join.key === input.joinKey && p.join.expiresAt > now)
          : -1;
        if (replayIndex >= 0) {
          const replayed = people[replayIndex]!;
          if (replayed.join!.name !== normalizedName) {
            throw new AppError('CONFLICT', 'joinKeyReused');
          }
          if (idsMissing) await savePeople();
          return {
            personIndex: replayIndex,
            personId: replayed.id,
            personToken: replayed.personToken!,
            name: replayed.name,
          };
        }

        const personToken = issueGuestPersonToken();
        const joinRecord = input.joinKey
          ? { join: { key: input.joinKey, name: normalizedName, expiresAt: now + JOIN_REPLAY_WINDOW_MS } }
          : {};

        // Check if name already exists (case-insensitive)
        const existingIndex = people.findIndex((p) => normalizeGuestName(p.name) === normalizedName);
        if (existingIndex >= 0) {
          const existingPerson = people[existingIndex]!;
          // Someone has already joined as this person, and the caller doesn't hold their token.
          // Refuse, or anyone with the link could take over their identity by name.
          if (existingPerson.personToken || existingPerson.accountUserId) {
            throw new AppError('CONFLICT', 'joinNameTaken');
          }
          people[existingIndex] = {
            ...existingPerson,
            personToken,
            ...joinRecord,
          };
          await savePeople();
          return { personIndex: existingIndex, personId: existingPerson.id, personToken, name: existingPerson.name };
        }

        if (people.length >= MAX_SESSION_PEOPLE) {
          throw new AppError('BAD_REQUEST', 'sessionFull', { max: MAX_SESSION_PEOPLE });
        }

        const name = input.name.normalize('NFC').trim();
        const personId = newGuestPersonId(people.map((person) => person.id));
        people.push({
          id: personId,
          name,
          personToken,
          visualColorId: Math.max(people.length - 1, ...people.map((p) => p.visualColorId ?? -1)) + 1,
          ...joinRecord,
        });
        await savePeople();

        return { personIndex: people.length - 1, personId, personToken, name };
      });
    }),

  // How a returning device finds its person: by the token it stored when it joined, not by
  // name, since the receipt creator may correct a guest's name. A mutation so the token travels in
  // the request body, not a URL. Returns null when nobody holds the token any more. Doesn't
  // require CLAIMING: it only maps a token the caller holds to the index, id and name getSession
  // already shows, and the claim page also calls it on finalized splits (personal links work
  // there). Like getSession, it saves ids for people who have none yet (savePersonIds).
  resumeSession: publicProcedure
    .input(z.object({ token: shareTokenSchema, personToken: guestLinkSecretSchema }))
    .mutation(async ({ ctx, input }) => {
      // A claim page load resumes a few times at most (a personal link, accepting it, the stored
      // identity), plus retries on server errors, plus one membership check per session load
      // that no longer lists the device's person (i.e. once they were removed; see
      // needsMembershipCheck). Per share token like getSession's read budget,
      // not per IP: diners share NAT and client IP headers are client-supplied (the same reasons
      // as for joinSession).
      const { allowed } = checkTokenRateLimit(`guest-resume:${input.token}`, 120, 60 * 1000);
      if (!allowed) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      // Only what's needed: items and assignments can be large
      const session = await ctx.db.guestSplit.findUnique({
        where: { shareToken: shareLookupHash(input.token) },
        select: { id: true, expiresAt: true, people: true },
      });
      if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
      if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');

      const stored = session.people as GuestSessionPerson[];
      const people = (
        hasPersonIds(stored) ? stored : (await savePersonIds(ctx.db, session.id)).people
      ) as IdentifiedGuestPerson[];
      const personIndex = people.findIndex((p) => p.personToken === input.personToken);
      if (personIndex < 0) return null;
      return { personIndex, personId: people[personIndex]!.id, name: people[personIndex]!.name };
    }),

  editPersonName: publicProcedure
    .input(
      z
        .object({
          token: shareTokenSchema,
          // Optional only for the signed-in receipt creator: their own account
          // grants permission, no guest token belonging to somebody else needed.
          personToken: guestLinkSecretSchema.optional(),
          // Who to rename, by id (see targetIndexOrThrow)
          targetId: personIdSchema,
          newName: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        !checkClaimWriteRateLimit(
          'edit-name',
          input.token,
          // A named, bounded bucket for signed-in creators without guest tokens.
          input.personToken ?? (ctx.session?.user?.id ? `creator:${ctx.session.user.id}` : 'anonymous'),
        )
      ) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: shareLookupHash(input.token) },
        });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionFinalized');
        if (ctx.impersonating) throw new AppError('FORBIDDEN', 'notParticipant');

        const people = [...(session.people as GuestSessionPerson[])];
        if (hasDuplicateGuestNames(people.map((p) => p.name))) {
          throw new AppError('CONFLICT', 'nameTaken');
        }
        const targetIndex = targetIndexOrThrow(people, input.targetId);
        // 3.6.2: receipt creator is an authenticated account identity, not
        // the payer or someone presenting an invitation/guest token. A normal
        // guest can only rename the row to which their token is attached.
        const isCreator =
          !!session.userId && !!ctx.session?.user?.id && session.userId === ctx.session.user.id && !ctx.impersonating;
        const isSelf = !!input.personToken && people[targetIndex]!.personToken === input.personToken;
        // Only the real current representative's bearer token delegates a
        // receipt-local DISPLAY NAME edit. This does not update account profile
        // names or provide the target's token. Verify group topology anew
        // inside this same serializable receipt transaction.
        let delegatedGroupRename = false;
        if (!isCreator && !isSelf && input.personToken) {
          try {
            const authorization = authorizeReceiptPersonEdit(
              people,
              session.paidByIndex,
              input.personToken,
              input.targetId,
            );
            delegatedGroupRename = authorization.delegated;
          } catch {
            throw new AppError('FORBIDDEN', 'notParticipant');
          }
        }
        if (!isCreator && !isSelf && !delegatedGroupRename) {
          throw new AppError('FORBIDDEN', 'notParticipant');
        }
        // The verified owner and the creator's registered identity must never
        // be rewritten by a different representative. Other registered
        // members may receive a receipt-local display alias only.
        const targetAccount = people[targetIndex]!.accountUserId;
        const organizerId = parseExtractedData(session.receiptData).organizerPersonId;
        if (
          delegatedGroupRename &&
          (people[targetIndex]!.reservedOwner ||
            people[targetIndex]!.id === organizerId ||
            (targetAccount && targetAccount === session.userId))
        ) {
          throw new AppError('FORBIDDEN', 'notParticipant');
        }
        if (targetAccount && targetAccount !== ctx.session?.user?.id && !delegatedGroupRename) {
          throw new AppError('FORBIDDEN', 'notParticipant');
        }

        const normalizedNew = normalizeGuestName(input.newName);
        const boundOwnerIndex = people.findIndex(
          (p) => p.reservedOwner === true && normalizeGuestName(p.name) === RESERVED_OWNER_KEY,
        );
        if (
          (boundOwnerIndex >= 0 && normalizedNew === RESERVED_OWNER_KEY && targetIndex !== boundOwnerIndex) ||
          (boundOwnerIndex === targetIndex && input.newName.trim() !== RESERVED_OWNER_NAME)
        ) {
          throw new AppError('CONFLICT', 'nameTaken');
        }
        const conflict = people.findIndex((p, i) => i !== targetIndex && normalizeGuestName(p.name) === normalizedNew);
        if (conflict >= 0) throw new AppError('CONFLICT', 'nameTaken');

        const previous = people[targetIndex]!;
        const renamed = {
          ...previous,
          name: input.newName.normalize('NFC').trim(),
        };
        people[targetIndex] = isSelf && previous.name !== renamed.name ? markPersonalLinkReady(renamed) : renamed;
        enforceGuestKnownParts(
          parseGuestItems(session.items),
          people,
          parseGuestAssignments(session.assignments),
          parseExtractedData(session.receiptData).knownPartsByItem,
          false,
        );
        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            people: people as unknown as Prisma.InputJsonValue,
            ...invalidatePartsApproval(session.receiptData),
          },
        });
        return { success: true };
      });
    }),

  // Issue #17 §1: compare-and-set the payer by stable identity inside the
  // same retryable transaction as claims, finalization and payment writes.
  changePayer: protectedProcedure
    .input(
      z
        .object({
          token: shareTokenSchema,
          personId: personIdSchema,
          expectedRevision: z.string().uuid().nullable(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.impersonating) throw new AppError('FORBIDDEN', 'notParticipant');
      if (!checkClaimWriteRateLimit('change-payer', input.token, 'creator:' + ctx.user.id)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.userId !== ctx.user.id) throw new AppError('FORBIDDEN', 'notParticipant');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionFinalized');

        const people = session.people as GuestSessionPerson[];
        // Even stale/imported CLAIMING rows must not rewrite payment history.
        if (
          people.some((person) =>
            Object.entries(person).some(
              ([key, value]) =>
                key.startsWith('payment') &&
                key !== 'paymentGroupRepresentativeId' &&
                value !== undefined &&
                value !== null &&
                (!Array.isArray(value) || value.length > 0),
            ),
          )
        )
          throw new AppError('BAD_REQUEST', 'sessionFinalized');
        const targetIndex = targetIndexOrThrow(people, input.personId);
        const receipt = parseExtractedData(session.receiptData);
        const revision = typeof receipt.payerRevision === 'string' ? receipt.payerRevision : null;
        if (targetIndex === session.paidByIndex) return { success: true, revision };
        if (revision !== input.expectedRevision) throw new AppError('CONFLICT', 'splitBusy');

        // Remove the new payer from their reimbursement group. Preserve
        // the others, choosing a remaining representative if necessary.
        const identified = people as IdentifiedGuestPerson[];
        const groups = receiptPaymentMemberships(identified, session.paidByIndex)
          .filter((group) => group.grouped)
          .map((group) => {
            const memberIds = group.memberIds.filter((id) => id !== input.personId);
            return {
              memberIds,
              representativeId: group.representativeId === input.personId ? memberIds[0]! : group.representativeId,
            };
          })
          .filter((group) => group.memberIds.length >= 2);
        const updated = identified.map(({ paymentGroupRepresentativeId: _old, ...person }) => {
          void _old;
          return person;
        });
        const nextPeople = setReceiptPaymentGroups(updated, targetIndex, groups);
        const nextRevision = randomUUID();
        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            paidByIndex: targetIndex,
            people: nextPeople as unknown as Prisma.InputJsonValue,
            payerSbpPhone: null,
            payerSbpBankId: null,
            receiptData: { ...receipt, payerRevision: nextRevision } as Prisma.InputJsonValue,
          },
        });
        return { success: true, revision: nextRevision };
      });
    }),

  removePerson: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personToken: guestLinkSecretSchema,
        // Who to remove, by id (see targetIndexOrThrow)
        targetId: personIdSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('remove-person', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: shareLookupHash(input.token) },
        });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionFinalized');
        // Fixed places cannot be deleted through the legacy token endpoint:
        // deleting the creator or any slot would silently change guestCount.
        if (parseExtractedData(session.receiptData).guestSlotsMode === true) {
          throw new AppError('FORBIDDEN', 'notParticipant');
        }

        const people = [...(session.people as GuestSessionPerson[])];
        const isParticipant = people.some((p) => p.personToken === input.personToken);
        if (!isParticipant) throw new AppError('FORBIDDEN', 'notParticipant');
        const targetIndex = targetIndexOrThrow(people, input.targetId);
        // A known personId is an identifier, never a permission to eject its
        // holder. Only that exact guest or the authenticated receipt creator
        // can remove the row. A borrowed guest token does not grant creator
        // privileges and an impersonated account never inherits them.
        const isCreator = !!session.userId && session.userId === ctx.session?.user?.id && !ctx.impersonating;
        const isSelf = people[targetIndex]?.personToken === input.personToken;
        if (!isCreator && !isSelf) throw new AppError('FORBIDDEN', 'notParticipant');
        // No other person's guest token may eject the account-bound owner.
        if (people[targetIndex]?.accountUserId && people[targetIndex]?.personToken !== input.personToken) {
          throw new AppError('FORBIDDEN', 'notParticipant');
        }
        if (people.length <= 1) throw new AppError('BAD_REQUEST', 'cannotRemoveLastPerson');

        // Never silently assign another payer during a removal.
        if (targetIndex === session.paidByIndex) throw new AppError('BAD_REQUEST', 'changePayerBeforeRemove');

        const removedPersonId = people[targetIndex]?.id;
        people.splice(targetIndex, 1);

        // Remap assignments: remove the person and shift indices down
        const assignments = (session.assignments as GuestPortionAssignment[])
          .map((a) => {
            const partsByPersonId = { ...(a.partsByPersonId ?? {}) };
            if (removedPersonId) delete partsByPersonId[removedPersonId];
            return {
              itemIndex: a.itemIndex,
              personIndices: a.personIndices
                .filter((pi) => pi !== targetIndex)
                .map((pi) => (pi > targetIndex ? pi - 1 : pi)),
              ...(a.partsByPersonId ? { partsByPersonId } : {}),
            };
          })
          .filter((a) => a.personIndices.length > 0);

        // Keep the very same payer identity when another row moves.
        const paidByIndex = session.paidByIndex - (targetIndex < session.paidByIndex ? 1 : 0);

        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            people: people as unknown as Prisma.InputJsonValue,
            assignments: assignments as unknown as Prisma.InputJsonValue,
            paidByIndex,
            ...invalidatePartsApproval(session.receiptData),
          },
        });
        return { success: true };
      });
    }),

  // Note (Finding #12): createClaimSession auto-splits multi-quantity items to qty=1,
  // so this endpoint is unreachable for sessions created by current code. However, it
  // remains useful for sessions where items were manually edited to have qty>1 after
  // creation, or if the auto-split logic changes in the future.
  splitClaimItem: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personToken: guestLinkSecretSchema,
        itemIndex: z.number().int().min(0),
        splitQuantity: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('split-item', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: shareLookupHash(input.token) },
        });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionFinalized');

        const people = session.people as GuestSessionPerson[];
        const actorIndex = people.findIndex((p) => p.personToken === input.personToken);
        if (actorIndex < 0) throw new AppError('FORBIDDEN', 'notParticipant');
        // Splitting a dish that somebody else has already claimed changes the
        // shared receipt item and their price. It needs the actual creator's
        // authenticated permission, not simply any guest's valid bearer.
        const isCreator = !!session.userId && session.userId === ctx.session?.user?.id && !ctx.impersonating;
        const modifiesOtherClaims = (session.assignments as GuestPortionAssignment[]).some(
          (assignment) =>
            assignment.itemIndex === input.itemIndex && assignment.personIndices.some((index) => index !== actorIndex),
        );
        if (modifiesOtherClaims && !isCreator) throw new AppError('FORBIDDEN', 'notParticipant');

        const items = [
          ...(session.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[]),
        ];
        if (input.itemIndex >= items.length) throw new AppError('BAD_REQUEST', 'invalidItemIndex');

        const currentData = parseExtractedData(session.receiptData);
        if (
          currentData.knownPartsByItem &&
          typeof currentData.knownPartsByItem === 'object' &&
          Object.keys(currentData.knownPartsByItem).length > 0
        ) {
          throw new AppError('PRECONDITION_FAILED', 'receiptKnownPartsSplitItem');
        }
        const item = items[input.itemIndex]!;
        if (input.splitQuantity >= item.quantity) {
          throw new AppError('BAD_REQUEST', 'splitQuantityOverItem');
        }

        const maxNewTotal = item.totalPrice - 1;
        if (maxNewTotal <= 0) throw new AppError('BAD_REQUEST', 'itemPriceTooLowToSplit');

        const newTotalPrice = Math.min(item.unitPrice * input.splitQuantity, maxNewTotal);
        const remainingQty = item.quantity - input.splitQuantity;
        const remainingTotalPrice = item.totalPrice - newTotalPrice;

        items[input.itemIndex] = { ...item, quantity: remainingQty, totalPrice: remainingTotalPrice };
        items.splice(input.itemIndex + 1, 0, {
          name: item.name,
          quantity: input.splitQuantity,
          unitPrice: item.unitPrice,
          totalPrice: newTotalPrice,
        });

        // Remap assignments: shift indices after insertion point
        const assignments = (session.assignments as GuestPortionAssignment[]).map((a) => ({
          ...a,
          itemIndex: a.itemIndex > input.itemIndex ? a.itemIndex + 1 : a.itemIndex,
          personIndices: [...a.personIndices],
        }));

        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            items: items as unknown as Prisma.InputJsonValue,
            assignments: assignments as unknown as Prisma.InputJsonValue,
            ...invalidatePartsApproval(session.receiptData),
          },
        });
        return { success: true, itemCount: items.length };
      });
    }),

  // Each person retains their own voluntary tip; the authorized payment
  // group representative may edit it on that person's behalf. This does
  // not add a shared tip or an extra item to the original receipt.
  setPersonalTip: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        tipCents: z.number().int().min(0).max(MAX_MONEY_CENTS),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('personal-tip', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) {
          throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
        }

        const people = session.people as GuestSessionPerson[];
        const {
          actorIndex,
          targetIndex: personIndex,
          delegated,
        } = authorizeReceiptPersonEdit(people, session.paidByIndex, input.personToken, input.personId);

        // Setting the same amount twice, including the default zero, is a
        // no-op. Different devices are serialized through guestTransaction.
        if ((people[personIndex]!.tipCents ?? 0) !== input.tipCents) {
          const updated = people.map((person, index) => {
            if (index !== personIndex) return person;
            const changed = { ...person, tipCents: input.tipCents };
            return delegated
              ? appendDelegatedReceiptAudit(changed, people[actorIndex]!.id!, input.personId, 'personal-tip')
              : markPersonalLinkReady(changed);
          });
          await tx.guestSplit.update({
            where: { id: session.id },
            data: { people: updated as unknown as Prisma.InputJsonValue },
          });
        }
        return { success: true, tipCents: input.tipCents };
      });
    }),

  // Issue #10 23–30: atomic per-item allocations, without creating new people.
  setReceiptItemParts: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personToken: guestLinkSecretSchema.optional(),
        itemIndex: z.number().int().min(0),
        changes: z
          .array(z.object({ personId: personIdSchema, parts: z.number().int().min(0).max(10000) }))
          .min(1)
          .max(MAX_SESSION_PEOPLE),
        requestKey: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rateActor = input.personToken ?? (ctx.session?.user?.id ? 'creator:' + ctx.session.user.id : '');
      if (!rateActor || !checkClaimWriteRateLimit('receipt-item-parts', input.token, rateActor)) {
        throw new AppError('TOO_MANY_REQUESTS', 'claimRateLimited');
      }
      if (new Set(input.changes.map((entry) => entry.personId)).size !== input.changes.length) {
        throw new AppError('BAD_REQUEST', 'invalidData', { label: 'duplicate personId' });
      }
      const orderedChanges = [...input.changes].sort((a, b) => a.personId.localeCompare(b.personId));
      const hash = createHash('sha256')
        .update(JSON.stringify([input.itemIndex, orderedChanges]))
        .digest('hex');
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const people = assignPersonIds(session.people as GuestSessionPerson[]);
        const isCreator = !!session.userId && session.userId === ctx.session?.user?.id && !ctx.impersonating;
        const creatorId = parseExtractedData(session.receiptData).organizerPersonId ?? people[0]?.id;
        // Author controls dish portions for everyone in THIS receipt, including
        // when any payment groups exist. This is not a financial or tip permission.
        const canCreatorAllocate = isCreator;
        const actorIndex = isCreator
          ? people.findIndex((p) => p.id === creatorId)
          : people.findIndex((p) => !!input.personToken && p.personToken === input.personToken);
        if (actorIndex < 0 || (!isCreator && !input.personToken)) {
          throw new AppError('FORBIDDEN', 'notParticipant');
        }
        // Creator authority comes exclusively from authenticated userId (not a
        // person token); non-creators must still prove their own/group permission.
        for (const entry of orderedChanges) {
          if (canCreatorAllocate) {
            if (!people.some((p) => p.id === entry.personId)) throw new AppError('NOT_FOUND', 'personGone');
          } else {
            if (!input.personToken) throw new AppError('FORBIDDEN', 'notParticipant');
            authorizeReceiptPersonEdit(people, session.paidByIndex, input.personToken, entry.personId);
          }
        }
        const actor = people[actorIndex]!;
        const past = actor.itemAllocationSaves ?? [];
        const replay = past.find((record) => record.key === input.requestKey);
        if (replay) {
          if (replay.hash !== hash) throw new AppError('CONFLICT', 'saveKeyReused');
          return { success: true, replayed: true };
        }
        if (session.status !== GuestSplitStatus.CLAIMING) {
          throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
        }
        const items = parseGuestItems(session.items);
        if (input.itemIndex >= items.length) throw new AppError('BAD_REQUEST', 'invalidItemIndex');
        const assignments = materializeGuestPersonalParts(
          cloneAssignments(session.assignments as GuestPortionAssignment[]),
          people,
        );
        let target = assignments.find((assignment) => assignment.itemIndex === input.itemIndex);
        if (!target) {
          target = { itemIndex: input.itemIndex, personIndices: [], partsByPersonId: {} };
          assignments.push(target);
        }
        const partsMap = { ...(target.partsByPersonId ?? {}) };
        const before = JSON.stringify([target.personIndices, partsMap]);
        for (const entry of orderedChanges) {
          const idx = people.findIndex((person) => person.id === entry.personId);
          if (entry.parts === 0) {
            target.personIndices = target.personIndices.filter((current) => current !== idx);
            delete partsMap[entry.personId];
          } else {
            if (!target.personIndices.includes(idx)) target.personIndices.push(idx);
            partsMap[entry.personId] = entry.parts;
          }
        }
        target.personIndices.sort((a, b) => a - b);
        target.partsByPersonId = partsMap;
        const changed = before !== JSON.stringify([target.personIndices, partsMap]);
        const nextAssignments = assignments.filter((assignment) => assignment.personIndices.length > 0);
        enforceGuestKnownParts(
          items,
          people,
          nextAssignments,
          parseExtractedData(session.receiptData).knownPartsByItem,
          false,
        );
        calculateSplitTotals({
          items,
          assignments: guestPortionAssignments(nextAssignments, people),
          tax: 0,
          tip: 0,
          peopleCount: people.length,
          ...groupSizeWeights(people),
        });
        const updatedPeople: GuestSessionPerson[] = people.map((person, index) => {
          let next: GuestSessionPerson = person;
          if (changed && index !== actorIndex && orderedChanges.some((entry) => entry.personId === person.id)) {
            next = appendDelegatedReceiptAudit(person, actor.id!, person.id!, 'item-parts', input.itemIndex);
          } else if (changed && index === actorIndex) {
            next = markPersonalLinkReady(person);
          }
          if (index === actorIndex) {
            next = { ...next, itemAllocationSaves: [...past, { key: input.requestKey, hash }].slice(-40) };
          }
          return next;
        });
        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            ...(changed
              ? {
                  assignments: nextAssignments as unknown as Prisma.InputJsonValue,
                  ...invalidatePartsApproval(session.receiptData),
                }
              : {}),
            people: updatedPeople as unknown as Prisma.InputJsonValue,
          },
        });
        return { success: true, replayed: false };
      });
    }),

  // A guest adjusts their own portions, or a group representative adjusts
  // portions for a member of their current validated payment group. Preserve
  // the same atomic save and parts-balance semantics for both callers.
  setMyItemParts: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        itemIndex: z.number().int().min(0),
        parts: z.number().int().min(1).max(10000),
        // The same key identifies the same absolute SET across lost answers,
        // retries and automatic transaction replay. Old clients may omit it.
        saveKey: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('personal-parts', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'claimRateLimited');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const people = session.people as GuestSessionPerson[];
        const {
          actorIndex,
          targetIndex: personIndex,
          delegated,
        } = authorizeReceiptPersonEdit(people, session.paidByIndex, input.personToken, input.personId);

        // Look up a previously committed key before checking whether the
        // split has meanwhile been finalized or a guest unclaimed the dish.
        // An unchanged replay must NEVER overwrite a later save (including
        // another save by the very same person on another device).
        const priorSaves = validSaveRecords(people[personIndex]!.personalPartSaves);
        const save = input.saveKey ? { key: input.saveKey, hash: personalPartsSaveHash(input) } : null;
        const earlier = save ? priorSaves.find((record) => record.key === save.key) : undefined;
        if (save && earlier) {
          if (earlier.hash !== save.hash) throw new AppError('CONFLICT', 'saveKeyReused');
          const committedAssignments = session.assignments as GuestPortionAssignment[];
          const balance = guestKnownPartsBalance({
            items: session.items as { totalPrice: number }[],
            people,
            assignments: committedAssignments,
            knownPartsByItem: parseExtractedData(session.receiptData).knownPartsByItem,
          });
          return {
            success: true,
            parts: input.parts,
            remainingParts: balance.progressByItem[String(input.itemIndex)]?.remainingParts ?? null,
          };
        }
        if (session.status !== GuestSplitStatus.CLAIMING) {
          throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
        }
        const items = session.items as { totalPrice: number }[];
        if (input.itemIndex >= items.length) throw new AppError('BAD_REQUEST', 'invalidItemIndex');
        const assignments = cloneAssignments(session.assignments as GuestPortionAssignment[]);
        const target = assignments.find(
          (item) => item.itemIndex === input.itemIndex && item.personIndices.includes(personIndex),
        );
        if (!target) throw new AppError('PRECONDITION_FAILED', 'itemsUnassigned');
        // All counts below come from one PostgreSQL Repeatable Read snapshot.
        // On a concurrent write, PostgreSQL aborts this transaction and
        // guestTransaction retries from a fresh snapshot, preserving the
        // other participant's already committed number of parts.
        const knownPartsByItem = parseExtractedData(session.receiptData).knownPartsByItem;
        const progressBefore = guestKnownPartsBalance({
          items,
          people,
          assignments,
          knownPartsByItem,
        }).progressByItem[String(input.itemIndex)];
        const savedParts = target.partsByPersonId?.[input.personId] ?? people[personIndex]!.groupSize ?? 1;
        // A set is an absolute number, never a delta added again after retry.
        // Only an explicitly declared original count imposes a free-parts limit.
        if (progressBefore && input.parts > savedParts && input.parts - savedParts > progressBefore.remainingParts) {
          throw new AppError('PRECONDITION_FAILED', 'receiptKnownPartsOverclaimed', undefined, {
            remainingParts: Math.max(0, progressBefore.remainingParts),
          });
        }
        let progressAfter = progressBefore;
        const changed = target.partsByPersonId?.[input.personId] !== input.parts;
        if (changed) {
          target.partsByPersonId = { ...target.partsByPersonId, [input.personId]: input.parts };
          progressAfter = enforceGuestKnownParts(items, people, assignments, knownPartsByItem, false).progressByItem[
            String(input.itemIndex)
          ];
          // Enforce the stored result is still an integer-kopeck division of
          // the same receipt item before persisting.
          calculateSplitTotals({
            items,
            assignments: guestPortionAssignments([target], people),
            tax: 0,
            tip: 0,
            peopleCount: people.length,
            ...groupSizeWeights(people),
          });
        }
        // Record the operation key in the SAME database transaction as the
        // count. Under PostgreSQL Repeatable Read any concurrent write to
        // this GuestSplit row aborts/retries both together, never just one.
        if (changed || save) {
          const updatePeople =
            save ||
            (changed && delegated) ||
            (!people[personIndex]!.personalLinkReadyAt && people[personIndex]!.guestSlotNumber !== undefined)
              ? people.map((person, index) => {
                  if (index !== personIndex) return person;
                  const edited =
                    changed && delegated
                      ? appendDelegatedReceiptAudit(
                          person,
                          people[actorIndex]!.id!,
                          input.personId,
                          'item-parts',
                          input.itemIndex,
                        )
                      : changed
                        ? markPersonalLinkReady(person)
                        : person;
                  return {
                    ...edited,
                    ...(save ? { personalPartSaves: [...priorSaves, save].slice(-SAVE_KEYS_KEPT) } : {}),
                  };
                })
              : null;
          await tx.guestSplit.update({
            where: { id: session.id },
            data: {
              ...(changed
                ? {
                    assignments: assignments as unknown as Prisma.InputJsonValue,
                    ...invalidatePartsApproval(session.receiptData),
                  }
                : {}),
              ...(updatePeople ? { people: updatePeople as unknown as Prisma.InputJsonValue } : {}),
            },
          });
        }
        return {
          success: true,
          parts: input.parts,
          // Null is significant: no original number of pieces was declared,
          // so there is no artificial "free remainder" to report or enforce.
          remainingParts: progressAfter?.remainingParts ?? null,
        };
      });
    }),

  claimItems: publicProcedure
    .input(
      z
        .object({
          token: shareTokenSchema,
          // Whose claims these are, by id (see targetIndexOrThrow)
          personId: personIdSchema,
          // Authenticated creator can allocate without a recovered personal
          // bearer credential; every other caller still needs their own token.
          personToken: guestLinkSecretSchema.optional(),
          // The person's whole claim set, replacing what is stored (older clients) ...
          claimedItemIndices: z.array(z.number().int().min(0)).max(1000).optional(),
          // ... or the items added to and removed from it (the claim page), applied to whatever is
          // stored when the save arrives, so another device's changes to other items are kept (#226)
          addItemIndices: z.array(z.number().int().min(0)).max(1000).optional(),
          removeItemIndices: z.array(z.number().int().min(0)).max(1000).optional(),
          // An idempotency key the page made for this save. Remembered (with a digest of the
          // changes) on the caller's person, so a retry of a save whose answer was lost answers
          // as stored instead of applying the changes again over what other devices saved since;
          // the same key with other changes is refused (#238)
          saveKey: z.string().uuid().optional(),
        })
        .refine(
          (input) => claimsOneWay(input.claimedItemIndices, input.addItemIndices, input.removeItemIndices),
          CLAIMS_ONE_WAY,
        )
        .refine((input) => addsAndRemovesApart(input.addItemIndices, input.removeItemIndices), ADD_OR_REMOVE),
    )
    .mutation(async ({ ctx, input }) => {
      const rateActor = input.personToken ?? (ctx.session?.user?.id ? 'creator:' + ctx.session.user.id : '');
      if (!rateActor || !checkClaimWriteRateLimit('claim', input.token, rateActor)) {
        throw new AppError('TOO_MANY_REQUESTS', 'claimRateLimited');
      }

      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: shareLookupHash(input.token) },
        });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');

        const people = session.people as GuestSessionPerson[];
        const items = session.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[];

        // Only the authenticated, non-impersonated author can allocate to
        // anybody in this receipt, independent of payment group membership.
        // Author idempotency is stored on the original organizer's stable row.
        const creatorCanAllocate = !!session.userId && session.userId === ctx.session?.user?.id && !ctx.impersonating;
        const creatorId = parseExtractedData(session.receiptData).organizerPersonId ?? people[0]?.id;
        // Preserve the caller's original retry-key owner when a real personal
        // token is supplied, including by a signed-in creator. An author who
        // lost that token falls back to their stable organizer row.
        const tokenActorIndex = people.findIndex((p) => !!input.personToken && p.personToken === input.personToken);
        const callerIndex =
          tokenActorIndex >= 0
            ? tokenActorIndex
            : creatorCanAllocate
              ? people.findIndex((p) => p.id === creatorId)
              : -1;
        if (callerIndex < 0 || (!creatorCanAllocate && !input.personToken)) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        // A public personId alone never grants access. For anyone other than
        // the verified creator, enforce the existing representative/self ACL.
        if (people.some((p) => p.id === input.personId)) {
          if (!creatorCanAllocate) {
            authorizeReceiptPersonEdit(people, session.paidByIndex, input.personToken!, input.personId);
          }
        } else if (!creatorCanAllocate) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }

        // A retry of a save that was stored: answer as stored, without applying it again. Checked
        // before the status, person and item checks, since what those check may have changed
        // since (e.g. someone finalized the split after the save was stored).
        const callerSaves = validSaveRecords(people[callerIndex]!.saves);
        const save = input.saveKey ? { key: input.saveKey, hash: claimChangesHash(input) } : null;
        const earlier = save ? callerSaves.find((record) => record.key === save.key) : undefined;
        if (save && earlier) {
          if (earlier.hash !== save.hash) {
            throw new AppError('CONFLICT', 'saveKeyReused');
          }
          // Conflicts as stored now (none if the person has been removed since)
          const storedIndex = findTargetIndex(people, input.personId);
          const stored = session.assignments as { itemIndex: number; personIndices: number[] }[];
          return { success: true, conflicts: storedIndex < 0 ? [] : claimConflicts(stored, people, storedIndex) };
        }

        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');

        const personIndex = targetIndexOrThrow(people, input.personId);
        const delegated = creatorCanAllocate
          ? false
          : authorizeReceiptPersonEdit(people, session.paidByIndex, input.personToken!, input.personId).delegated;

        for (const idx of [
          ...(input.claimedItemIndices ?? []),
          ...(input.addItemIndices ?? []),
          ...(input.removeItemIndices ?? []),
        ]) {
          if (idx >= items.length) {
            throw new AppError('BAD_REQUEST', 'invalidItemIndexValue', { index: idx });
          }
        }

        const assignments = cloneAssignments(session.assignments as GuestPortionAssignment[]);
        const earlierClaims = new Set(
          assignments.filter((a) => a.personIndices.includes(personIndex)).map((a) => a.itemIndex),
        );

        // The person's claims after this save: the set sent, or what is stored now with the
        // changes applied
        const claimedSet = new Set(
          input.claimedItemIndices ??
            assignments.filter((a) => a.personIndices.includes(personIndex)).map((a) => a.itemIndex),
        );
        for (const idx of input.addItemIndices ?? []) claimedSet.add(idx);
        for (const idx of input.removeItemIndices ?? []) claimedSet.delete(idx);

        // Remove the claimed person without touching other people's portions.
        for (const a of assignments) {
          a.personIndices = a.personIndices.filter((pi) => pi !== personIndex);
          if (!claimedSet.has(a.itemIndex) && a.partsByPersonId) {
            delete a.partsByPersonId[input.personId];
          }
        }

        // Add this person to claimed items
        for (const itemIdx of claimedSet) {
          let assignment = assignments.find((a) => a.itemIndex === itemIdx);
          if (!assignment) {
            assignment = { itemIndex: itemIdx, personIndices: [] };
            assignments.push(assignment);
          }
          if (!assignment.personIndices.includes(personIndex)) {
            assignment.personIndices.push(personIndex);
          }
        }

        // The upstream personIndices list only records *who* chose the
        // dish. BillOK stores *how many parts* every claimant consumes in a
        // separate, stable-ID map. Keep prior explicit numbers when a second
        // guest joins; initialize a new claimant from their group size.
        // Also migrate pre-3.19 rows without changing the proportions.
        const cleanedAssignments = materializeGuestPersonalParts(
          assignments.filter((a) => a.personIndices.length > 0),
          people,
        );

        enforceGuestKnownParts(
          items,
          people,
          cleanedAssignments,
          parseExtractedData(session.receiptData).knownPartsByItem,
          false,
        );

        // The save key goes on the caller's person with this save, newest last
        const actualTargetEdit =
          earlierClaims.size !== claimedSet.size || [...claimedSet].some((item) => !earlierClaims.has(item));
        const actualOwnEdit = callerIndex === personIndex && actualTargetEdit;
        const withSaveKey =
          save || actualOwnEdit || (delegated && actualTargetEdit)
            ? people.map((person, index) => {
                const withSave =
                  save && index === callerIndex
                    ? { ...person, saves: [...callerSaves, save].slice(-SAVE_KEYS_KEPT) }
                    : person;
                if (index === personIndex && delegated && actualTargetEdit) {
                  return appendDelegatedReceiptAudit(withSave, people[callerIndex]!.id!, input.personId, 'claim-items');
                }
                return index === personIndex && actualOwnEdit ? markPersonalLinkReady(withSave) : withSave;
              })
            : null;

        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            assignments: cleanedAssignments as unknown as Prisma.InputJsonValue,
            ...invalidatePartsApproval(session.receiptData),
            ...(withSaveKey ? { people: withSaveKey as unknown as Prisma.InputJsonValue } : {}),
          },
        });

        // Check for conflicts: items in this person's claim set that are also claimed by others
        return { success: true, conflicts: claimConflicts(cleanedAssignments, people, personIndex) };
      });
    }),

  /** 3.5: a current browser tab declares presence for its own joined person.
   * Independent row per device: one closed tab does not mark another tab offline.
   * The database supplies the time; a client cannot forge the status or another person.
   */
  heartbeatPresence: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        deviceId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkGuestPresenceHeartbeatLimit(input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const session = await ctx.db.guestSplit.findUnique({
        where: { shareToken: shareLookupHash(input.token) },
        select: { id: true, expiresAt: true, status: true, people: true },
      });
      if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
      if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
      if (session.status !== GuestSplitStatus.CLAIMING) {
        throw new AppError('BAD_REQUEST', 'sessionAlreadyFinalized');
      }
      const people = session.people as GuestSessionPerson[];
      const person = people.find((entry) => entry.id === input.personId);
      if (!person?.personToken || person.personToken !== input.personToken) {
        throw new AppError('FORBIDDEN', 'invalidPersonToken');
      }
      const seen = new Date();
      await ctx.db.guestPresence.upsert({
        where: {
          sessionId_personId_deviceId: {
            sessionId: session.id,
            personId: input.personId,
            deviceId: input.deviceId,
          },
        },
        create: {
          sessionId: session.id,
          personId: input.personId,
          deviceId: input.deviceId,
          lastSeenAt: seen,
        },
        update: { lastSeenAt: seen },
      });
      return { success: true };
    }),

  /** 3.8.2: a personal link is a bearer credential. Only the signed-in
   * creator of THIS receipt may request a guest's saved credential. Use POST
   * (mutation) so the secret never appears in URLs or public query caches.
   * The UI builds a #fragment link client-side; fragments never reach HTTP.
   */
  /** 3.8.4: a creator rotates exactly one guest's personal bearer credential.
   * The old token and its join replay key lose authority in the same commit.
   * Do not touch personId, account binding, assignments, payments or tips.
   */
  rotateGuestPersonalLink: protectedProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        requestKey: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.impersonating) throw new AppError('FORBIDDEN', 'notParticipant');
      const bucket = `guest-rotate-personal-link:${JSON.stringify([input.token, ctx.user.id])}`;
      if (!checkTokenRateLimit(bucket, 12, 60_000).allowed) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session || session.userId !== ctx.user.id) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (parseExtractedData(session.receiptData).guestSlotsMode !== true) {
          throw new AppError('BAD_REQUEST', 'invalidData', { label: 'fixed guest slots' });
        }
        const people = assignPersonIds(session.people as GuestSessionPerson[]);
        const idx = people.findIndex((person) => person.id === input.personId && person.guestSlotNumber !== undefined);
        if (idx < 0) throw new AppError('NOT_FOUND', 'personGone');
        const guest = people[idx]!;
        if (!guest.personToken) throw new AppError('PRECONDITION_FAILED', 'guestPersonalLinkNotJoined');
        if (!guest.personalLinkReadyAt) throw new AppError('PRECONDITION_FAILED', 'guestPersonalLinkNotReady');

        const previousRotation = guest.personalLinkRotation;
        // A retry of an already committed rotation must not invalidate the
        // credential it returned on the first (possibly lost) response.
        if (previousRotation?.requestKey === input.requestKey) {
          return {
            personId: guest.id,
            name: guest.name,
            personToken: guest.personToken,
            rotatedAt: previousRotation.rotatedAt,
            rotationCount: previousRotation.count,
          };
        }

        const rotatedAt = new Date().toISOString();
        const personToken = issueGuestPersonToken();
        const rotationCount = Math.min((previousRotation?.count ?? 0) + 1, 1_000_000);
        // Remove prior join-key and save-key replays: neither may be used to
        // retrieve this fresh secret with an old request from another device.
        const { join: _priorJoin, saves: _priorSaves, ...retained } = guest;
        void _priorJoin;
        void _priorSaves;
        people[idx] = {
          ...retained,
          personToken,
          personalLinkRotation: { requestKey: input.requestKey, rotatedAt, count: rotationCount },
        };
        await tx.guestSplit.update({
          where: { id: session.id },
          data: { people: people as unknown as Prisma.InputJsonValue },
        });
        // The response contains the NEW secret only for the authenticated
        // creator; the audit event stores no old token or request URL.
        return { personId: guest.id, name: guest.name, personToken, rotatedAt, rotationCount };
      });
    }),

  getGuestPersonalLink: protectedProcedure
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.impersonating) throw new AppError('FORBIDDEN', 'notParticipant');
      if (
        !checkTokenRateLimit(`guest-creator-personal-link:${JSON.stringify([input.token, ctx.user.id])}`, 30, 60_000)
          .allowed
      ) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const session = await ctx.db.guestSplit.findUnique({
        where: { shareToken: shareLookupHash(input.token) },
        select: { userId: true, expiresAt: true, receiptData: true, people: true },
      });
      // Hide existence of other people's receipts from all registered users,
      // including delegated organizers and the system-wide BillOK owner.
      if (!session || session.userId !== ctx.user.id) {
        throw new AppError('NOT_FOUND', 'sessionNotFound');
      }
      if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
      if (parseExtractedData(session.receiptData).guestSlotsMode !== true) {
        throw new AppError('BAD_REQUEST', 'invalidData', { label: 'fixed guest slots' });
      }
      const guest = (session.people as GuestSessionPerson[]).find(
        (person) => person.id === input.personId && person.guestSlotNumber !== undefined,
      );
      if (!guest) throw new AppError('NOT_FOUND', 'personGone');
      if (!guest.personToken) throw new AppError('PRECONDITION_FAILED', 'guestPersonalLinkNotJoined');
      if (!guest.personalLinkReadyAt) throw new AppError('PRECONDITION_FAILED', 'guestPersonalLinkNotReady');
      // No plain personal token is returned by getSession, getSplit, or an
      // invite: this explicit creator-only mutation is the sole exception.
      return { personId: guest.id!, name: guest.name, personToken: guest.personToken };
    }),

  getSession: publicProcedure.input(z.object({ token: shareTokenSchema })).query(async ({ ctx, input }) => {
    if (!checkSessionReadRateLimit(input.token)) {
      throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
    }

    let session = await ctx.db.guestSplit.findUnique({
      where: { shareToken: shareLookupHash(input.token) },
    });
    if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
    if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
    if (!hasPersonIds(session.people as GuestSessionPerson[])) session = await savePersonIds(ctx.db, session.id);

    const parsedData = parseExtractedData(session.receiptData);
    if (session.status === GuestSplitStatus.FINALIZED) {
      assertGuestSettlementUnchanged({
        receiptData: session.receiptData,
        people: session.people as GuestSessionPerson[],
        paidByIndex: session.paidByIndex,
        summary: (session.summary ?? []) as { personIndex: number; total: number; tip: number }[],
        receiptTotalCents: parsedData.total,
      });
    }
    const canViewPresence = canFinalizeGuestSession(session.userId, parsedData, ctx.session?.user?.id);
    const latestPresence =
      canViewPresence && session.status === GuestSplitStatus.CLAIMING
        ? await ctx.db.guestPresence.groupBy({
            by: ['personId'],
            where: { sessionId: session.id },
            _max: { lastSeenAt: true },
          })
        : null;
    const seenByPerson = new Map((latestPresence ?? []).map((entry) => [entry.personId, entry._max.lastSeenAt]));
    const presence =
      latestPresence === null
        ? null
        : (session.people as IdentifiedGuestPerson[]).map((entry) => ({
            personId: entry.id,
            status: guestPresenceState(!!entry.personToken, seenByPerson.get(entry.id)),
          }));

    return {
      id: session.id,
      shareToken: input.token,
      status: session.status,
      receiptData: (() => {
        const {
          finalizationOrganizerUserId: _privateOrganizer,
          paymentSettlementLock: _privateSettlement,
          ...visible
        } = parseExtractedData(session.receiptData);
        void _privateOrganizer;
        void _privateSettlement;
        return visible;
      })() as {
        merchantName?: string;
        date?: string;
        subtotal: number;
        tax: number;
        tip: number;
        total: number;
        currency: string;
        roundingBalanced?: boolean;
        organizerPersonId?: string;
        guestSlotsMode?: boolean;
        guestCount?: number;
        knownPartsByItem?: Record<string, number>;
      },
      items: session.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[],
      // Everyone has an id by now (savePersonIds above)
      people: toClaimPeople(session.people as IdentifiedGuestPerson[]),
      // Creator-only audit metadata, not a public token or an owner privilege.
      personalLinkEvents:
        session.userId === ctx.session?.user?.id && !ctx.impersonating
          ? (session.people as IdentifiedGuestPerson[])
              .filter((person) => person.guestSlotNumber !== undefined && person.personalLinkRotation)
              .map((person) => ({
                personId: person.id,
                rotatedAt: person.personalLinkRotation!.rotatedAt,
                rotationCount: person.personalLinkRotation!.count,
              }))
          : null,
      presence, // organizer-only; never leaks personal tokens or heartbeat timestamps
      assignments: session.assignments as GuestPortionAssignment[],
      finalizationRevision: guestFinalizationRevision({
        items: parseGuestItems(session.items),
        people: session.people as GuestSessionPerson[],
        assignments: parseGuestAssignments(session.assignments),
        receiptData: parsedData,
        paidByIndex: session.paidByIndex,
      }),
      partsConfirmed: (() => {
        const data = parseExtractedData(session.receiptData);
        if (typeof data.organizerPersonId !== 'string') return true; // old sessions
        return (
          typeof data.partsApprovalHash === 'string' &&
          data.partsApprovalHash ===
            guestPartsDigest({
              items: parseGuestItems(session.items),
              people: session.people as GuestSessionPerson[],
              assignments: parseGuestAssignments(session.assignments),
              knownPartsByItem: data.knownPartsByItem,
            })
        );
      })(),
      summary: session.summary as
        | {
            personIndex: number;
            name: string;
            itemTotal: number;
            tax: number;
            tip: number;
            total: number;
            roundingCorrectionCents?: number;
          }[]
        | null,
      paidByIndex: session.paidByIndex,
      payerRevision: typeof parsedData.payerRevision === 'string' ? parsedData.payerRevision : null,
      isCreator: !!session.userId && session.userId === ctx.session?.user?.id && !ctx.impersonating,
      canFinalize: canFinalizeGuestSession(
        session.userId,
        parseExtractedData(session.receiptData),
        ctx.session?.user?.id,
      ),
      hasFinalizationOrganizer: typeof parseExtractedData(session.receiptData).finalizationOrganizerUserId === 'string',
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    };
  }),

  // 3.15: creator corrections are edits of the ORIGINAL receipt position,
  // not a new expense or payment. Every viewer sees the corrected saved item
  // and the recomputed total through the existing getSession update path.
  // Keep the index and the identities/portion assignments stable; replacing
  // or renumbering other rows is not allowed through this operation.
  // Issue 3.24.1.2: only the signed-in creator may edit group composition.
  // One atomic complete set handles merge, split and change of representative.
  // No dish/portion/tip changes or new receipt rows.
  setPaymentGroups: protectedProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        groups: z
          .array(
            z.object({
              representativeId: personIdSchema,
              memberIds: z.array(personIdSchema).min(2).max(MAX_SESSION_PEOPLE),
            }),
          )
          .max(Math.floor(MAX_SESSION_PEOPLE / 2)),
        // New tabbed editor supplies this to reject stale whole-set writes.
        // Optional for existing clients, which retain the legacy API contract.
        expectedGroupRevision: z.string().max(20000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        !checkTokenRateLimit('payment-group-edit:' + JSON.stringify([input.token, ctx.user.id]), 30, 60_000).allowed
      ) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (!session.userId || session.userId !== ctx.user.id || ctx.impersonating) {
          throw new AppError('FORBIDDEN', 'notParticipant');
        }
        if (session.status !== GuestSplitStatus.CLAIMING) {
          throw new AppError('BAD_REQUEST', 'sessionFinalized');
        }
        const existing = assignPersonIds(session.people as GuestSessionPerson[]);
        if (input.expectedGroupRevision !== undefined) {
          let actualGroups: { representativeId: string; memberIds: string[] }[];
          try {
            actualGroups = receiptPaymentMemberships(existing, session.paidByIndex)
              .filter((group) => group.grouped)
              .map(({ representativeId, memberIds }) => ({ representativeId, memberIds }));
          } catch {
            throw new AppError('CONFLICT', 'splitBusy');
          }
          if (receiptGroupsRevision(actualGroups) !== input.expectedGroupRevision) {
            throw new AppError('CONFLICT', 'splitBusy');
          }
        }
        let updated: IdentifiedGuestPerson[];
        try {
          updated = setReceiptPaymentGroups(existing, session.paidByIndex, input.groups);
        } catch {
          throw new AppError('BAD_REQUEST', 'invalidData', { label: 'payment groups' });
        }
        const changed = JSON.stringify(existing) !== JSON.stringify(updated);
        if (changed || !hasPersonIds(session.people as GuestSessionPerson[])) {
          await tx.guestSplit.update({
            where: { id: session.id },
            data: { people: updated as unknown as Prisma.InputJsonValue },
          });
        }
        return {
          groups: receiptPaymentMemberships(updated, session.paidByIndex)
            .filter((group) => group.grouped)
            .map(({ representativeId, memberIds }) => ({ representativeId, memberIds })),
        };
      });
    }),

  updateClaimReceiptItem: protectedProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        itemIndex: z.number().int().min(0),
        name: z.string().trim().min(1).max(160),
        quantity: z.number().int().min(1).max(200),
        unitPrice: z.number().int().min(1).max(MAX_MONEY_CENTS),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionAlreadyFinalized');
        if (session.userId !== ctx.user.id || ctx.impersonating) throw new AppError('FORBIDDEN');

        const items = parseGuestItems(session.items);
        if (input.itemIndex >= items.length) throw new AppError('BAD_REQUEST', 'invalidItemIndex');
        const value = input.quantity * input.unitPrice;
        if (!Number.isSafeInteger(value) || value > MAX_MONEY_CENTS) {
          throw new AppError('BAD_REQUEST', 'invalidData', { label: 'receipt amount' });
        }
        const nextItems = items.map((item, index) =>
          index === input.itemIndex
            ? { name: input.name, quantity: input.quantity, unitPrice: input.unitPrice, totalPrice: value }
            : item,
        );
        const total = nextItems.reduce((sum, item) => sum + item.totalPrice, 0);
        if (!Number.isSafeInteger(total) || total > MAX_MONEY_CENTS) {
          throw new AppError('BAD_REQUEST', 'invalidData', { label: 'receipt total' });
        }
        const originalData = parseExtractedData(session.receiptData);
        // New BillOK receipts have no extra tax/shared tip. Corrections must
        // never create an amount independent of an actual position in the bill.
        if (originalData.tax !== 0 || originalData.tip !== 0 || originalData.currency !== 'RUB') {
          throw new AppError('BAD_REQUEST', 'invalidData', { label: 'receipt correction' });
        }
        const changed = items[input.itemIndex]!;
        if (
          changed.name === input.name &&
          changed.quantity === input.quantity &&
          changed.unitPrice === input.unitPrice &&
          changed.totalPrice === value &&
          originalData.subtotal === total &&
          originalData.total === total
        )
          return { success: true, total, itemIndex: input.itemIndex };

        enforceGuestKnownParts(
          nextItems,
          parseGuestPeople(session.people),
          parseGuestAssignments(session.assignments),
          originalData.knownPartsByItem,
          false,
        );
        const nextData: Record<string, unknown> = { ...originalData, subtotal: total, total };
        delete nextData.partsApprovalHash;
        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            items: nextItems as unknown as Prisma.InputJsonValue,
            receiptData: nextData as Prisma.InputJsonValue,
          },
        });
        return { success: true, total, itemIndex: input.itemIndex };
      }),
    ),

  // Only the registered creator may declare or clear an original number of
  // portions for a guest item. This is NOT the item quantity or a price.
  setKnownItemParts: protectedProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        itemIndex: z.number().int().min(0),
        totalParts: z.number().int().min(1).max(10000).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionAlreadyFinalized');
        if (!session.userId || session.userId !== ctx.user.id) throw new AppError('FORBIDDEN');

        const items = parseGuestItems(session.items);
        if (input.itemIndex >= items.length) throw new AppError('BAD_REQUEST', 'invalidItemIndex');
        const data = parseExtractedData(session.receiptData);
        const existing = data.knownPartsByItem;
        const saved =
          existing && typeof existing === 'object' && !Array.isArray(existing)
            ? { ...(existing as Record<string, unknown>) }
            : {};
        const key = String(input.itemIndex);
        if ((saved[key] ?? null) === input.totalParts) return { success: true, totalParts: input.totalParts };
        if (input.totalParts === null) delete saved[key];
        else saved[key] = input.totalParts;
        enforceGuestKnownParts(
          items,
          parseGuestPeople(session.people),
          parseGuestAssignments(session.assignments),
          saved,
          false,
        );
        const next: Record<string, unknown> = { ...data, knownPartsByItem: saved };
        delete next.partsApprovalHash;
        await tx.guestSplit.update({
          where: { id: session.id },
          data: { receiptData: next as Prisma.InputJsonValue },
        });
        return { success: true, totalParts: input.totalParts };
      }),
    ),

  // Only the signed-in creator can appoint or revoke one registered co-organizer.
  // No guest token, payer identity or guessed share link grants this permission.
  setFinalizationOrganizer: protectedProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        email: z.string().trim().email().max(254).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) {
          throw new AppError('BAD_REQUEST', 'sessionAlreadyFinalized');
        }
        if (!session.userId || session.userId !== ctx.user.id) throw new AppError('FORBIDDEN');
        const data = parseExtractedData(session.receiptData);
        let organizerId: string | null = null;
        if (input.email !== null) {
          const account = await tx.user.findUnique({
            where: { email: input.email.toLowerCase() },
            select: {
              id: true,
              email: true,
              suspendedAt: true,
              isPlaceholder: true,
              emailVerified: true,
              registrationEmailVerificationRequired: true,
            },
          });
          if (
            !account ||
            account.suspendedAt ||
            account.isPlaceholder ||
            !isAllowedRegistrationEmailDomain(account.email) ||
            (account.registrationEmailVerificationRequired && !account.emailVerified) ||
            account.id === ctx.user.id
          ) {
            throw new AppError('BAD_REQUEST', 'invalidData', { label: 'registered co-organizer' });
          }
          organizerId = account.id;
        }
        const next = { ...data };
        delete next.finalizationOrganizerUserId;
        if (organizerId) next.finalizationOrganizerUserId = organizerId;
        // A delegation change invalidates the previous approval: the newly
        // authorized organizer must confirm the same current assignments again.
        delete next.partsApprovalHash;
        await tx.guestSplit.update({
          where: { id: session.id },
          data: { receiptData: next as Prisma.InputJsonValue },
        });
        return { success: true, delegated: !!organizerId };
      }),
    ),

  // The registered creator or their explicitly appointed co-organizer approves
  // the exact stored guest claims. A subsequent edit removes this approval.
  confirmSessionParts: protectedProcedure
    .input(z.object({ token: shareTokenSchema }))
    .mutation(async ({ ctx, input }) =>
      guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionAlreadyFinalized');
        if (!canFinalizeGuestSession(session.userId, parseExtractedData(session.receiptData), ctx.user.id)) {
          throw new AppError('FORBIDDEN');
        }
        const data = parseExtractedData(session.receiptData);
        const people = parseGuestPeople(session.people);
        if (
          typeof data.organizerPersonId !== 'string' ||
          !people.some((person) => person.id === data.organizerPersonId)
        ) {
          throw new AppError('PRECONDITION_FAILED', 'invalidData', { label: 'receipt organizer' });
        }
        const items = parseGuestItems(session.items);
        const assignments = parseGuestAssignments(session.assignments);
        const claimed = new Set(assignments.filter((a) => a.personIndices.length > 0).map((a) => a.itemIndex));
        if (!items.length || items.some((_, index) => !claimed.has(index))) {
          throw new AppError('PRECONDITION_FAILED', 'itemsUnassigned');
        }
        enforceGuestKnownParts(items, people, assignments, data.knownPartsByItem, true);
        const hash = guestPartsDigest({ items, people, assignments, knownPartsByItem: data.knownPartsByItem });
        await tx.guestSplit.update({
          where: { id: session.id },
          data: { receiptData: { ...data, partsApprovalHash: hash } as Prisma.InputJsonValue },
        });
        return { success: true };
      }),
    ),

  finalizeSession: protectedProcedure
    .input(
      z
        .object({
          token: shareTokenSchema,
          // Optional legacy personal identity. An authorized registered organizer
          // can finalize without becoming a bill participant who owes money.
          personId: personIdSchema.optional(),
          personToken: guestLinkSecretSchema.optional(),
          expectedRevision: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          tipOverride: z.never().optional(), // no shared tip override
        })
        .refine((value) => (value.personId === undefined) === (value.personToken === undefined), {
          message: 'Person ID and personal token must be supplied together',
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const { shareToken, finalizeLog } = await guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: shareLookupHash(input.token) },
        });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionAlreadyFinalized');

        const items = parseGuestItems(session.items);
        const people = parseGuestPeople(session.people);
        const assignments = parseGuestAssignments(session.assignments);
        const receiptData = parseExtractedData(session.receiptData);
        if (!canFinalizeGuestSession(session.userId, receiptData, ctx.user.id)) {
          throw new AppError('FORBIDDEN');
        }

        // A registered organizer need not claim dishes to be authorized:
        // optional legacy personal credentials are still validated if supplied.
        if (input.personId !== undefined && input.personToken !== undefined) {
          const person = people[targetIndexOrThrow(people, input.personId)];
          if (!person?.personToken || person.personToken !== input.personToken) {
            throw new AppError('FORBIDDEN', 'invalidPersonToken');
          }
        }

        // Every item needs a claimant. The claim page only offers Finalize when it sees that, but
        // it checks the session as last loaded, so a removal that commits after its check (another
        // device, or a save whose answer was lost) would otherwise finalize a split with an item
        // nobody pays for (#237). Checked here, inside the transaction: at Repeatable Read, a
        // removal committed after this read makes the update below fail and the retry sees it.
        const claimed = new Set(assignments.filter((a) => a.personIndices.length > 0).map((a) => a.itemIndex));
        if (items.some((_, index) => !claimed.has(index))) {
          throw new AppError('PRECONDITION_FAILED', 'itemsUnassigned');
        }

        const revision = guestFinalizationRevision({
          items,
          people: session.people as GuestSessionPerson[],
          assignments,
          receiptData,
          paidByIndex: session.paidByIndex,
        });
        if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
          throw new AppError('CONFLICT', 'receiptFinalizationChanged');
        }

        // A receipt creator must have acknowledged this exact set of claims
        // in the same repeatable-read snapshot used to produce the final shares.
        if (
          input.expectedRevision === undefined &&
          typeof receiptData.organizerPersonId === 'string' &&
          (typeof receiptData.partsApprovalHash !== 'string' ||
            receiptData.partsApprovalHash !==
              guestPartsDigest({ items, people, assignments, knownPartsByItem: receiptData.knownPartsByItem }))
        ) {
          throw new AppError('PRECONDITION_FAILED', 'receiptPartsConfirmationRequired');
        }

        enforceGuestKnownParts(items, people, assignments, receiptData.knownPartsByItem, true);
        const tip = receiptData.tip;

        // This session's organizer is identified by their original stable
        // person ID, never paidByIndex or their position in the array.
        const organizerPersonId = receiptData.organizerPersonId;
        const organizerIndex =
          typeof organizerPersonId === 'string' ? people.findIndex((entry) => entry.id === organizerPersonId) : -1;
        if (receiptData.roundingBalanced === true && typeof organizerPersonId === 'string' && organizerIndex < 0) {
          throw new AppError('PRECONDITION_FAILED', 'invalidData', { label: 'receipt organizer' });
        }

        // Each person's groupSize weights the items they share
        const itemShares = calculateSplitTotals({
          items,
          assignments: guestPortionAssignments(assignments, people),
          tax: receiptData.tax,
          tip,
          peopleCount: people.length,
          balanceAcrossItems: receiptData.roundingBalanced === true,
          ...(organizerIndex >= 0 ? { organizerIndex } : {}),
          ...groupSizeWeights(people),
        });
        let summary: ReturnType<typeof calculateSplitTotals>;
        try {
          summary = addPersonalGuestTips(
            itemShares,
            people,
            new Set(assignments.flatMap((assignment) => assignment.personIndices)),
          );
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          throw new AppError('BAD_REQUEST', 'receiptPersonalTipsInvalid', undefined, { cause: error });
        }

        const summaryWithNames = summary.map((s) => ({
          ...s,
          name: people[s.personIndex]?.name ?? `Person ${s.personIndex + 1}`,
        }));

        // A payer can cover the family bill without eating a dish. The
        // calculator omits non-consumers; the payment ledger needs exactly
        // one row per participant. Add only zero-kopeck entries in grouped
        // receipts; the original dish allocations and tips remain intact.
        if (
          (session.people as GuestSessionPerson[]).some((person) => person.paymentGroupRepresentativeId !== undefined)
        ) {
          const included = new Set(summary.map((person) => person.personIndex));
          people.forEach((person, personIndex) => {
            if (!included.has(personIndex)) {
              summaryWithNames.push({
                personIndex,
                name: person.name,
                itemTotal: 0,
                tax: 0,
                tip: 0,
                total: 0,
              });
            }
          });
        }

        // Stable personal IDs must already be part of the finalized ledger.
        // Some legacy sessions were finalized without ever opening getSession;
        // assign IDs in this SAME transaction so a later read cannot change
        // the amount lock by lazily assigning IDs.
        const finalizedPeople = assignPersonIds(session.people as GuestSessionPerson[]);

        // 5.20: commit the exact receipt shares, family-payment membership
        // and a separate immutable checksum in the SAME finalization write.
        // Payment actions will reject altered financial rows, rather than
        // attributing an earlier declaration to a newly calculated amount.
        const paymentSettlementLock = {
          version: 1 as const,
          lockedAt: new Date().toISOString(),
          digest: guestSettlementDigest({
            people: finalizedPeople,
            paidByIndex: session.paidByIndex,
            summary: summaryWithNames,
            receiptTotalCents: receiptData.total,
          }),
        };
        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            status: GuestSplitStatus.FINALIZED,
            people: finalizedPeople as unknown as Prisma.InputJsonValue,
            summary: summaryWithNames as unknown as Prisma.InputJsonValue,
            receiptData: {
              ...receiptData,
              partsApprovalHash: guestPartsDigest({
                items,
                people,
                assignments,
                knownPartsByItem: receiptData.knownPartsByItem,
              }),
              paymentSettlementLock,
            } as Prisma.InputJsonValue,
            assignments: assignments as unknown as Prisma.InputJsonValue,
          },
        });

        return {
          shareToken: input.token,
          finalizeLog: true,
        };
      });

      // Log only once the transaction has committed; the callback may run more than once.
      if (finalizeLog) logger.info('guest.session.finalized');
      return { shareToken };
    }),

  // The declaration is NOT a bank transaction and never means the payer has
  // received money. A person's own token is needed both to read and to write.
  getMyPaymentDeclaration: publicProcedure
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: guestLinkSecretSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-read', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: shareLookupHash(input.token) },
        select: {
          expiresAt: true,
          status: true,
          people: true,
          paidByIndex: true,
          receiptData: true,
          summary: true,
          assignments: true,
        },
      });
      if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
      if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
      const { people, personIndex, paymentIndex, paymentPerson, amountCents, group } = requireGuestDebtor(
        split,
        input.personId,
        input.personToken,
      );
      // 5.14: the payer's verified incoming transfer is independent of whether
      // the sender remembered to declare "I paid" (including family groups).
      const verifiedAt = paymentPerson.paymentVerifiedAt ?? null;
      // 5.10: notification metadata is private to the actual sender's personal
      // token. Family spectators may see their shared status but not the
      // sender's personal confirmation notification.
      const receiptName = (split.receiptData as { merchantName?: unknown }).merchantName;
      const payer = people[split.paidByIndex]!;
      const storedNotice =
        verifiedAt && personIndex === paymentIndex ? paymentPerson.paymentReceiptNotification : undefined;
      const notification = storedNotice
        ? {
            ...storedNotice,
            readAt: storedNotice.readAt ?? null,
            receiptHref: '/split/' + encodeURIComponent(input.token) + '/claim',
          }
        : null;
      const cancellationNotifications =
        personIndex === paymentIndex
          ? (paymentPerson.paymentReceiptCancellationNotifications ?? []).map((entry) => ({
              ...entry,
              readAt: entry.readAt ?? null,
              receiptHref: '/split/' + encodeURIComponent(input.token) + '/claim',
            }))
          : [];
      return {
        declaredPaidAt: paymentPerson.paymentDeclaredAt ?? null,
        declaredAmountCents: paymentPerson.paymentDeclaredAt
          ? (paymentPerson.paymentDeclaredAmountCents ?? amountCents)
          : null,
        verifiedAt,
        // 5.22: the actual sender sees only their own incoming bank reconciliation.
        ...(personIndex === paymentIndex
          ? {
              actualReceipt: payerActualReceiptSnapshot(
                paymentPerson,
                amountCents,
                group?.tipCents ??
                  (split.summary as { personIndex: number; total: number; tip: number }[]).find(
                    (entry) => entry.personIndex === paymentIndex,
                  )?.tip ??
                  0,
              ),
            }
          : {}),
        ...(notification ? { notification } : {}),
        ...(cancellationNotifications.length ? { cancellationNotifications } : {}),
        ...(verifiedAt && personIndex === paymentIndex
          ? {
              confirmationNotice: {
                payerName: notification?.payerName ?? payer.name,
                amountCents: notification?.amountCents ?? amountCents,
                receiptName:
                  notification?.receiptName ??
                  (typeof receiptName === 'string' && receiptName.trim() ? receiptName.trim() : 'Чек'),
                confirmedAt: notification?.confirmedAt ?? verifiedAt,
                receiptHref: '/split/' + encodeURIComponent(input.token) + '/claim',
              },
            }
          : {}),
      };
    }),

  // Optional VAPID public key; absent until deployment supplies both key halves.
  getGuestPushConfig: publicProcedure.query(() => ({ publicKey: guestPushPublicKey() })),

  getMyGuestPushStatus: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        endpoint: z.string().max(2048),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-read', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: shareLookupHash(input.token) },
        select: {
          expiresAt: true,
          status: true,
          people: true,
          paidByIndex: true,
          receiptData: true,
          summary: true,
          assignments: true,
        },
      });
      if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
      if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
      const { paymentPerson, personIndex, paymentIndex } = requireGuestDebtor(split, input.personId, input.personToken);
      if (personIndex !== paymentIndex) throw new AppError('FORBIDDEN', 'notParticipant');
      return {
        subscribed:
          !!guestPushPublicKey() &&
          activeGuestPushSubscriptions(paymentPerson.guestPushSubscriptions, input.personToken).some(
            (subscription) => subscription.endpoint === input.endpoint,
          ),
      };
    }),

  subscribeMyGuestPush: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        subscription: z.strictObject({
          endpoint: z.string().max(2048),
          keys: z.strictObject({ p256dh: z.string().max(140), auth: z.string().max(80) }),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!guestPushPublicKey() || !validGuestPushSubscription(input.subscription)) {
        throw new AppError('BAD_REQUEST');
      }
      if (!checkClaimWriteRateLimit('guest-push-subscription', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, paymentIndex, personIndex, paymentPerson } = requireGuestDebtor(
          split,
          input.personId,
          input.personToken,
        );
        if (paymentIndex !== personIndex) throw new AppError('FORBIDDEN', 'notParticipant');
        const saved = validStoredGuestPushSubscriptions(paymentPerson.guestPushSubscriptions);
        const updated = [
          ...saved.filter((entry) => entry.endpoint !== input.subscription.endpoint),
          { ...input.subscription, tokenBinding: guestPushTokenBinding(input.personToken) },
        ].slice(-MAX_GUEST_PUSH_SUBSCRIPTIONS);
        if (
          saved.length !== updated.length ||
          saved.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(updated[index]))
        ) {
          await tx.guestSplit.update({
            where: { id: split.id },
            data: {
              people: people.map((person, index) =>
                index === paymentIndex ? { ...person, guestPushSubscriptions: updated } : person,
              ) as unknown as Prisma.InputJsonValue,
            },
          });
        }
        return { subscribed: true };
      });
    }),

  unsubscribeMyGuestPush: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        endpoint: z.string().max(2048),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!validGuestPushEndpoint(input.endpoint)) throw new AppError('BAD_REQUEST');
      if (!checkClaimWriteRateLimit('guest-push-subscription', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, paymentIndex, personIndex, paymentPerson } = requireGuestDebtor(
          split,
          input.personId,
          input.personToken,
        );
        if (paymentIndex !== personIndex) throw new AppError('FORBIDDEN', 'notParticipant');
        const saved = validStoredGuestPushSubscriptions(paymentPerson.guestPushSubscriptions);
        const updated = saved.filter((entry) => entry.endpoint !== input.endpoint);
        if (updated.length !== saved.length) {
          await tx.guestSplit.update({
            where: { id: split.id },
            data: {
              people: people.map((person, index) =>
                index === paymentIndex ? { ...person, guestPushSubscriptions: updated } : person,
              ) as unknown as Prisma.InputJsonValue,
            },
          });
        }
        return { subscribed: false };
      });
    }),

  markMyPaymentNotificationRead: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        notificationId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-write', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, personIndex, paymentIndex, paymentPerson } = requireGuestDebtor(
          split,
          input.personId,
          input.personToken,
        );
        if (personIndex !== paymentIndex) throw new AppError('FORBIDDEN', 'notParticipant');
        const notice = paymentPerson.paymentReceiptNotification;
        const cancellations = paymentPerson.paymentReceiptCancellationNotifications ?? [];
        const isConfirmation = notice?.id === input.notificationId;
        const cancellation = cancellations.find((entry) => entry.id === input.notificationId);
        if (!isConfirmation && !cancellation) throw new AppError('NOT_FOUND');
        const saved = isConfirmation ? notice! : cancellation!;
        if (saved.readAt) return { readAt: saved.readAt };
        const readAt = new Date().toISOString();
        await tx.guestSplit.update({
          where: { id: split.id },
          data: {
            people: people.map((person, index) =>
              index !== paymentIndex
                ? person
                : isConfirmation
                  ? { ...person, paymentReceiptNotification: { ...notice!, readAt } }
                  : {
                      ...person,
                      paymentReceiptCancellationNotifications: cancellations.map((entry) =>
                        entry.id === input.notificationId ? { ...entry, readAt } : entry,
                      ),
                    },
            ) as unknown as Prisma.InputJsonValue,
          },
        });
        return { readAt };
      });
    }),

  markMyPayment: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        // One UUID per deliberate participant button press; optional for
        // existing clients with the same strictly verified personal token.
        requestId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-write', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, paymentPerson, paymentIndex, personIndex, amountCents } = requireGuestDebtor(
          split,
          input.personId,
          input.personToken,
        );
        // A group member's personal link can read the group status but can
        // never declare another transfer for the same shared debt.
        if (paymentIndex !== personIndex) throw new AppError('FORBIDDEN', 'notParticipant');
        const previousRequest = paymentPerson.paymentDeclarationActionRequests?.find(
          (entry) => entry.id === input.requestId,
        );
        if (previousRequest) {
          if (previousRequest.action !== 'mark') throw new AppError('CONFLICT', 'splitBusy');
          // Return the CURRENT state, never the original declaration of an
          // old request that may have been explicitly revoked later.
          return {
            declaredPaidAt: paymentPerson.paymentDeclaredAt ?? null,
            declaredAmountCents: paymentPerson.paymentDeclaredAt
              ? (paymentPerson.paymentDeclaredAmountCents ?? amountCents)
              : null,
          };
        }
        const requestRecord = input.requestId
          ? { id: input.requestId, action: 'mark' as const, at: new Date().toISOString() }
          : null;
        const addHistory = (entry: typeof paymentPerson) =>
          requestRecord
            ? {
                ...entry,
                paymentDeclarationActionRequests: [
                  ...(entry.paymentDeclarationActionRequests ?? []),
                  requestRecord,
                ].slice(-32),
              }
            : entry;
        if (paymentPerson.paymentDeclaredAt || paymentPerson.paymentVerifiedAt) {
          // The status is already settled; retain a newly seen request key to
          // prevent its retry from re-marking after a subsequent unmark.
          if (requestRecord) {
            await tx.guestSplit.update({
              where: { id: split.id },
              data: {
                people: people.map((entry, index) =>
                  index === paymentIndex ? addHistory(entry) : entry,
                ) as unknown as Prisma.InputJsonValue,
              },
            });
          }
          // The payer's independent verification already satisfies the debt.
          // A late participant declaration must not create a second payment
          // or fabricate a timestamp for a button they never clicked.
          return {
            declaredPaidAt: paymentPerson.paymentDeclaredAt ?? null,
            declaredAmountCents: paymentPerson.paymentDeclaredAt
              ? (paymentPerson.paymentDeclaredAmountCents ?? amountCents)
              : null,
          };
        }
        const timestamp = new Date().toISOString();
        const updated = people.map((entry, index) =>
          index === paymentIndex
            ? addHistory({ ...entry, paymentDeclaredAt: timestamp, paymentDeclaredAmountCents: amountCents })
            : entry,
        );
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: updated as unknown as Prisma.InputJsonValue },
        });
        return { declaredPaidAt: timestamp, declaredAmountCents: amountCents };
      });
    }),

  // A debtor may retract their own claim, but never undo the payer's confirmed receipt.
  // The read and write share the same serialized GuestSplit transaction as payer confirmation.
  unmarkMyPayment: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        requestId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-write', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, paymentPerson, paymentIndex, personIndex } = requireGuestDebtor(
          split,
          input.personId,
          input.personToken,
        );
        if (paymentIndex !== personIndex) throw new AppError('FORBIDDEN', 'notParticipant');
        const previousRequest = paymentPerson.paymentDeclarationActionRequests?.find(
          (entry) => entry.id === input.requestId,
        );
        if (previousRequest) {
          if (previousRequest.action !== 'unmark') throw new AppError('CONFLICT', 'splitBusy');
          return {
            declaredPaidAt: paymentPerson.paymentDeclaredAt ?? null,
            verifiedAt: paymentPerson.paymentVerifiedAt ?? null,
          };
        }
        if (paymentPerson.paymentVerifiedAt) {
          throw new AppError('BAD_REQUEST', 'paymentAlreadyVerified');
        }
        const timestamp = new Date().toISOString();
        const requestRecord = input.requestId
          ? { id: input.requestId, action: 'unmark' as const, at: timestamp }
          : null;
        if (!paymentPerson.paymentDeclaredAt) {
          // Even a no-op must remember its key: a delayed old unmark must not
          // cancel a NEW explicit mark in another tab.
          if (requestRecord) {
            await tx.guestSplit.update({
              where: { id: split.id },
              data: {
                people: people.map((entry, index) =>
                  index === paymentIndex
                    ? {
                        ...entry,
                        paymentDeclarationActionRequests: [
                          ...(entry.paymentDeclarationActionRequests ?? []),
                          requestRecord,
                        ].slice(-32),
                      }
                    : entry,
                ) as unknown as Prisma.InputJsonValue,
              },
            });
          }
          return { declaredPaidAt: null, verifiedAt: null };
        }
        const updated = people.map((entry, index) => {
          if (index !== paymentIndex) return entry;
          const cleared = { ...entry };
          delete cleared.paymentDeclaredAt;
          delete cleared.paymentDeclaredAmountCents;
          delete cleared.paymentVerifiedAt;
          delete cleared.paymentVerifiedByPersonId;
          // A durable, payer-visible revocation event, not just a transient
          // transition that may be missed during a quick mark/unmark/mark.
          return {
            ...cleared,
            paymentUnmarkedAt: timestamp,
            ...(requestRecord
              ? {
                  paymentDeclarationActionRequests: [
                    ...(cleared.paymentDeclarationActionRequests ?? []),
                    requestRecord,
                  ].slice(-32),
                }
              : {}),
          };
        });
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: updated as unknown as Prisma.InputJsonValue },
        });
        return { declaredPaidAt: null, verifiedAt: null };
      });
    }),

  // Payer-only private overview, including who declared a transfer and who
  // has had their incoming payment independently verified by the payer.
  getMyPayerPaymentReview: publicProcedure
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: guestLinkSecretSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-review', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: shareLookupHash(input.token) },
        select: {
          expiresAt: true,
          status: true,
          people: true,
          paidByIndex: true,
          receiptData: true,
          summary: true,
          assignments: true,
        },
      });
      if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
      if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
      const { people, summary, paymentGroups } = requireGuestPayerReview(split, input.personId, input.personToken);
      return {
        payments: paymentGroups
          ? paymentGroups
              .filter((group) => group.totalCents > 0)
              .map((group) => {
                const representative = people.find((person) => person.id === group.representativeId)!;
                return {
                  personId: representative.id!,
                  name: representative.name,
                  amount: group.totalCents,
                  ...payerActualReceiptSnapshot(representative, group.totalCents, group.tipCents),
                  declaredPaidAt: representative.paymentDeclaredAt ?? null,
                  ...(representative.paymentUnmarkedAt ? { unmarkedAt: representative.paymentUnmarkedAt } : {}),
                  verifiedAt: representative.paymentVerifiedAt ?? null,
                  verifiedByPersonId: representative.paymentVerifiedAt
                    ? (representative.paymentVerifiedByPersonId ?? null)
                    : null,
                  overpaymentChoice: representative.paymentOverpaymentChoice ?? null,
                  ...(representative.paymentRefunds?.length
                    ? {
                        confirmedRefunds: representative.paymentRefunds.map(({ id, amountCents, confirmedAt }) => ({
                          id,
                          amountCents,
                          confirmedAt,
                        })),
                      }
                    : {}),
                  ...(representative.paymentReceivedTransfers?.length
                    ? {
                        receivedTransfers: representative.paymentReceivedTransfers.map(
                          ({ id, amountCents, confirmedAt, cancelledAt, correctsTransferId }) => ({
                            id,
                            amountCents,
                            confirmedAt,
                            ...(cancelledAt ? { cancelledAt } : {}),
                            ...(correctsTransferId ? { correctsTransferId } : {}),
                          }),
                        ),
                      }
                    : {}),
                  ...(group.grouped ? { memberIds: group.memberIds, members: group.members } : {}),
                };
              })
          : summary
              .filter((entry) => entry.personIndex !== split.paidByIndex && entry.total > 0)
              .map((entry) => {
                const person = people[entry.personIndex]!;
                return {
                  personId: person.id!,
                  name: person.name,
                  amount: entry.total,
                  ...payerActualReceiptSnapshot(person, entry.total, entry.tip),
                  declaredPaidAt: person.paymentDeclaredAt ?? null,
                  ...(person.paymentUnmarkedAt ? { unmarkedAt: person.paymentUnmarkedAt } : {}),
                  verifiedAt: person.paymentVerifiedAt ?? null,
                  verifiedByPersonId: person.paymentVerifiedAt ? (person.paymentVerifiedByPersonId ?? null) : null,
                  overpaymentChoice: person.paymentOverpaymentChoice ?? null,
                  ...(person.paymentRefunds?.length
                    ? {
                        confirmedRefunds: person.paymentRefunds.map(({ id, amountCents, confirmedAt }) => ({
                          id,
                          amountCents,
                          confirmedAt,
                        })),
                      }
                    : {}),
                  ...(person.paymentReceivedTransfers?.length
                    ? {
                        receivedTransfers: person.paymentReceivedTransfers.map(
                          ({ id, amountCents, confirmedAt, cancelledAt, correctsTransferId }) => ({
                            id,
                            amountCents,
                            confirmedAt,
                            ...(cancelledAt ? { cancelledAt } : {}),
                            ...(correctsTransferId ? { correctsTransferId } : {}),
                          }),
                        ),
                      }
                    : {}),
                };
              }),
      };
    }),

  // 5.22.1–5.22.2: an actual incoming RUB transfer is recorded ONLY by the
  // finalized receipt's real payer, not by a sender/organizer/share-link holder.
  // Multiple transfers are separate immutable receipt records, never new expenses.
  recordGuestPaymentReceived: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        debtorId: personIdSchema,
        requestId: z.string().uuid(),
        receivedAmountCents: z.number().int().min(1).max(MAX_MONEY_CENTS),
        overpaymentChoice: z.enum(['tip', 'refund']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-verify', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const outcome = await guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, summary, paymentGroups } = requireGuestPayerReview(split, input.personId, input.personToken);
        const debtorIndex = people.findIndex((person) => person.id === input.debtorId);
        const validGroup = paymentGroups?.find(
          (group) => group.representativeId === input.debtorId && group.totalCents > 0,
        );
        const entry = summary.find((row) => row.personIndex === debtorIndex && row.total > 0);
        if (debtorIndex < 0 || debtorIndex === split.paidByIndex || (paymentGroups ? !validGroup : !entry)) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const expectedCents = validGroup?.totalCents ?? entry!.total;
        const declaredTipCents = validGroup?.tipCents ?? entry!.tip;
        const debtor = people[debtorIndex]!;
        const prior = debtor.paymentReceivedTransfers ?? [];
        const duplicate = prior.find((record) => record.id === input.requestId);
        if (duplicate) {
          if (
            duplicate.amountCents !== input.receivedAmountCents ||
            duplicate.cancelledAt ||
            (input.overpaymentChoice && input.overpaymentChoice !== debtor.paymentOverpaymentChoice)
          ) {
            throw new AppError('CONFLICT', 'splitBusy');
          }
          const current = payerActualReceiptSnapshot(debtor, expectedCents, declaredTipCents);
          return { ...current, verifiedAt: debtor.paymentVerifiedAt ?? null, delivery: null };
        }
        // An old confirmation did not record actual transfers. Never append to
        // an unknown bank total or invent its historical deposits.
        if (debtor.paymentVerifiedAt && prior.length === 0) {
          throw new AppError('CONFLICT', 'splitBusy');
        }
        const confirmedAt = new Date().toISOString();
        const transfers = [
          ...prior,
          {
            id: input.requestId,
            amountCents: input.receivedAmountCents,
            confirmedAt,
            confirmedByPersonId: input.personId,
          },
        ];
        const choice: ReceiptOverpaymentChoice | null =
          input.overpaymentChoice ?? debtor.paymentOverpaymentChoice ?? null;
        let totals;
        try {
          totals = reconcileActualReceiptTransfers(
            expectedCents,
            declaredTipCents,
            transfers,
            choice,
            debtor.paymentRefunds ?? [],
          );
        } catch {
          throw new AppError('CONFLICT', 'splitBusy');
        }
        // The payer explicitly decides whether surplus funds are tips or due
        // back. Never silently misclassify an accidental extra transfer.
        if (totals.pendingExcessCents > 0) throw new AppError('BAD_REQUEST', 'splitBusy');

        const fullyCovered = totals.outstandingCents === 0;
        const verifiedAt = fullyCovered ? (debtor.paymentVerifiedAt ?? confirmedAt) : null;
        const receiptName = (split.receiptData as { merchantName?: unknown }).merchantName;
        const receiptNotification =
          fullyCovered && !debtor.paymentVerifiedAt
            ? {
                id: randomUUID(),
                payerName: people[split.paidByIndex]!.name,
                amountCents: expectedCents,
                receiptName: typeof receiptName === 'string' && receiptName.trim() ? receiptName.trim() : 'Чек',
                confirmedAt: verifiedAt!,
              }
            : null;
        const updated = people.map((person, index) =>
          index === debtorIndex
            ? {
                ...person,
                paymentReceivedTransfers: transfers,
                ...(choice ? { paymentOverpaymentChoice: choice } : {}),
                ...(verifiedAt ? { paymentVerifiedAt: verifiedAt, paymentVerifiedByPersonId: input.personId } : {}),
                ...(receiptNotification ? { paymentReceiptNotification: receiptNotification } : {}),
              }
            : person,
        );
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: updated as unknown as Prisma.InputJsonValue },
        });
        return {
          ...totals,
          verifiedAt,
          delivery: receiptNotification
            ? {
                subscriptions: activeGuestPushSubscriptions(debtor.guestPushSubscriptions, debtor.personToken ?? ''),
                notificationId: receiptNotification.id,
              }
            : null,
        };
      });
      if (outcome.delivery) {
        try {
          await sendGuestReceiptPush(
            outcome.delivery.subscriptions,
            '/split/' + encodeURIComponent(input.token) + '/claim',
            outcome.delivery.notificationId,
          );
        } catch {
          // A push outage cannot undo a recorded incoming bank transfer.
        }
      }
      const { delivery: _delivery, ...response } = outcome;
      void _delivery;
      return response;
    }),

  // 5.22.4: void ONE erroneous payer-attested transfer without erasing the
  // other deposits. Keep the original record and the payer identity for audit.
  cancelGuestReceivedTransfer: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        debtorId: personIdSchema,
        transferId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-verify', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const outcome = await guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, summary, paymentGroups } = requireGuestPayerReview(split, input.personId, input.personToken);
        const debtorIndex = people.findIndex((person) => person.id === input.debtorId);
        const validGroup = paymentGroups?.find(
          (group) => group.representativeId === input.debtorId && group.totalCents > 0,
        );
        const entry = summary.find((row) => row.personIndex === debtorIndex && row.total > 0);
        if (debtorIndex < 0 || debtorIndex === split.paidByIndex || (paymentGroups ? !validGroup : !entry)) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const debtor = people[debtorIndex]!;
        const transfers = debtor.paymentReceivedTransfers ?? [];
        const target = transfers.find((record) => record.id === input.transferId);
        if (!target) throw new AppError('NOT_FOUND', 'paymentNotDeclared');
        const expectedCents = validGroup?.totalCents ?? entry!.total;
        const declaredTipCents = validGroup?.tipCents ?? entry!.tip;
        if (target.cancelledAt) {
          return {
            ...payerActualReceiptSnapshot(debtor, expectedCents, declaredTipCents),
            verifiedAt: debtor.paymentVerifiedAt ?? null,
            cancelledAt: target.cancelledAt,
            delivery: null,
          };
        }
        if (target.confirmedByPersonId !== input.personId) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const cancelledAt = new Date().toISOString();
        const corrected = transfers.map((record) =>
          record.id === input.transferId ? { ...record, cancelledAt, cancelledByPersonId: input.personId } : record,
        );
        let totals;
        try {
          totals = reconcileActualReceiptTransfers(
            expectedCents,
            declaredTipCents,
            corrected,
            debtor.paymentOverpaymentChoice ?? null,
            debtor.paymentRefunds ?? [],
          );
        } catch {
          // A refund already returned to the sender cannot be erased by
          // retroactively cancelling the deposit that funded it.
          throw new AppError('CONFLICT', 'splitBusy');
        }
        const lostFullConfirmation = !!debtor.paymentVerifiedAt && totals.outstandingCents > 0;
        const receiptName = (split.receiptData as { merchantName?: unknown }).merchantName;
        const cancellationEvent = lostFullConfirmation
          ? {
              id: randomUUID(),
              payerPersonId: input.personId,
              payerName: people[split.paidByIndex]!.name,
              amountCents: expectedCents,
              receiptName: typeof receiptName === 'string' && receiptName.trim() ? receiptName.trim() : 'Чек',
              cancelledAt,
            }
          : null;
        const updated = people.map((person, index) => {
          if (index !== debtorIndex) return person;
          const next = {
            ...person,
            paymentReceivedTransfers: corrected,
            ...(cancellationEvent
              ? {
                  paymentReceiptCancellationNotifications: [
                    ...(person.paymentReceiptCancellationNotifications ?? []),
                    cancellationEvent,
                  ].slice(-20),
                }
              : {}),
          };
          if (lostFullConfirmation) {
            delete next.paymentVerifiedAt;
            delete next.paymentVerifiedByPersonId;
          }
          return next;
        });
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: updated as unknown as Prisma.InputJsonValue },
        });
        return {
          ...totals,
          verifiedAt: lostFullConfirmation ? null : (debtor.paymentVerifiedAt ?? null),
          cancelledAt,
          delivery: cancellationEvent
            ? {
                subscriptions: activeGuestPushSubscriptions(debtor.guestPushSubscriptions, debtor.personToken ?? ''),
                notificationId: cancellationEvent.id,
              }
            : null,
        };
      });
      if (outcome.delivery) {
        try {
          await sendGuestReceiptPush(
            outcome.delivery.subscriptions,
            '/split/' + encodeURIComponent(input.token) + '/claim',
            outcome.delivery.notificationId,
            'cancelled',
          );
        } catch {
          // The saved addressed cancellation remains available without push.
        }
      }
      const { delivery: _delivery, ...response } = outcome;
      void _delivery;
      return response;
    }),

  // 5.22.4: atomic correction of ONE payer-entered bank receipt. Preserve
  // the original entry as cancelled and append a replacement in one TX.
  // Never transiently lose debt/tips if a mobile connection drops mid-edit.
  correctGuestReceivedTransfer: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        debtorId: personIdSchema,
        transferId: z.string().uuid(),
        requestId: z.string().uuid(),
        correctedAmountCents: z.number().int().min(1).max(MAX_MONEY_CENTS),
        overpaymentChoice: z.enum(['tip', 'refund']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-verify', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const outcome = await guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, summary, paymentGroups } = requireGuestPayerReview(split, input.personId, input.personToken);
        const debtorIndex = people.findIndex((person) => person.id === input.debtorId);
        const group = paymentGroups?.find((row) => row.representativeId === input.debtorId && row.totalCents > 0);
        const entry = summary.find((row) => row.personIndex === debtorIndex && row.total > 0);
        if (debtorIndex < 0 || debtorIndex === split.paidByIndex || (paymentGroups ? !group : !entry)) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const debtor = people[debtorIndex]!;
        const expectedCents = group?.totalCents ?? entry!.total;
        const tipCents = group?.tipCents ?? entry!.tip;
        const history = debtor.paymentReceivedTransfers ?? [];
        const retry = history.find((row) => row.id === input.requestId);
        if (retry) {
          if (
            retry.correctsTransferId !== input.transferId ||
            retry.amountCents !== input.correctedAmountCents ||
            !!retry.cancelledAt ||
            (input.overpaymentChoice && input.overpaymentChoice !== debtor.paymentOverpaymentChoice)
          ) {
            throw new AppError('CONFLICT', 'splitBusy');
          }
          return {
            ...payerActualReceiptSnapshot(debtor, expectedCents, tipCents),
            verifiedAt: debtor.paymentVerifiedAt ?? null,
            correctedTransferId: retry.id,
            delivery: null,
          };
        }
        if (input.requestId === input.transferId) throw new AppError('CONFLICT', 'splitBusy');
        const original = history.find((row) => row.id === input.transferId);
        if (!original || original.cancelledAt || original.confirmedByPersonId !== input.personId) {
          throw new AppError('CONFLICT', 'splitBusy');
        }
        const at = new Date().toISOString();
        const updatedHistory = [
          ...history.map((row) =>
            row.id === input.transferId ? { ...row, cancelledAt: at, cancelledByPersonId: input.personId } : row,
          ),
          {
            id: input.requestId,
            amountCents: input.correctedAmountCents,
            confirmedAt: at,
            confirmedByPersonId: input.personId,
            correctsTransferId: input.transferId,
          },
        ];
        const choice = input.overpaymentChoice ?? debtor.paymentOverpaymentChoice ?? null;
        let totals;
        try {
          totals = reconcileActualReceiptTransfers(
            expectedCents,
            tipCents,
            updatedHistory,
            choice,
            debtor.paymentRefunds ?? [],
          );
        } catch {
          throw new AppError('CONFLICT', 'splitBusy');
        }
        if (totals.pendingExcessCents > 0) throw new AppError('BAD_REQUEST', 'splitBusy');
        const nowVerified = totals.outstandingCents === 0;
        const wasVerified = !!debtor.paymentVerifiedAt;
        const verifiedAt = nowVerified ? (debtor.paymentVerifiedAt ?? at) : null;
        const receiptNameRaw = (split.receiptData as { merchantName?: unknown }).merchantName;
        const receiptName = typeof receiptNameRaw === 'string' && receiptNameRaw.trim() ? receiptNameRaw.trim() : 'Чек';
        const notification =
          nowVerified && !wasVerified
            ? {
                id: randomUUID(),
                payerName: people[split.paidByIndex]!.name,
                amountCents: expectedCents,
                receiptName,
                confirmedAt: verifiedAt!,
              }
            : null;
        const cancellation =
          !nowVerified && wasVerified
            ? {
                id: randomUUID(),
                payerPersonId: input.personId,
                payerName: people[split.paidByIndex]!.name,
                amountCents: expectedCents,
                receiptName,
                cancelledAt: at,
              }
            : null;
        const updated = people.map((person, index) => {
          if (index !== debtorIndex) return person;
          const next = {
            ...person,
            paymentReceivedTransfers: updatedHistory,
            ...(choice ? { paymentOverpaymentChoice: choice } : {}),
            ...(notification ? { paymentReceiptNotification: notification } : {}),
            ...(cancellation
              ? {
                  paymentReceiptCancellationNotifications: [
                    ...(person.paymentReceiptCancellationNotifications ?? []),
                    cancellation,
                  ].slice(-20),
                }
              : {}),
          };
          if (verifiedAt) {
            next.paymentVerifiedAt = verifiedAt;
            next.paymentVerifiedByPersonId = input.personId;
          } else {
            delete next.paymentVerifiedAt;
            delete next.paymentVerifiedByPersonId;
          }
          return next;
        });
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: updated as unknown as Prisma.InputJsonValue },
        });
        const event = notification ?? cancellation;
        return {
          ...totals,
          verifiedAt,
          correctedTransferId: input.requestId,
          delivery: event
            ? {
                subscriptions: activeGuestPushSubscriptions(debtor.guestPushSubscriptions, debtor.personToken ?? ''),
                notificationId: event.id,
                kind: cancellation ? ('cancelled' as const) : ('confirmed' as const),
              }
            : null,
        };
      });
      if (outcome.delivery) {
        try {
          await sendGuestReceiptPush(
            outcome.delivery.subscriptions,
            '/split/' + encodeURIComponent(input.token) + '/claim',
            outcome.delivery.notificationId,
            outcome.delivery.kind === 'cancelled' ? 'cancelled' : undefined,
          );
        } catch {
          // Stored audit and addressed notice survive push delivery failures.
        }
      }
      const { delivery: _delivery, ...result } = outcome;
      void _delivery;
      return result;
    }),

  // 5.22.3: revise the disposition of a real overpayment. Already refunded
  // money cannot subsequently be classified as a tip. All changes are logged.
  setGuestOverpaymentChoice: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        debtorId: personIdSchema,
        requestId: z.string().uuid(),
        choice: z.enum(['tip', 'refund']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-verify', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, summary, paymentGroups } = requireGuestPayerReview(split, input.personId, input.personToken);
        const debtorIndex = people.findIndex((person) => person.id === input.debtorId);
        const group = paymentGroups?.find((row) => row.representativeId === input.debtorId && row.totalCents > 0);
        const entry = summary.find((row) => row.personIndex === debtorIndex && row.total > 0);
        if (debtorIndex < 0 || debtorIndex === split.paidByIndex || (paymentGroups ? !group : !entry)) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const debtor = people[debtorIndex]!;
        const originalCents = group?.totalCents ?? entry!.total;
        const tipCents = group?.tipCents ?? entry!.tip;
        const oldEvents = debtor.paymentOverpaymentChoiceEvents ?? [];
        const seen = oldEvents.find((record) => record.id === input.requestId);
        if (seen) {
          if (seen.choice !== input.choice) throw new AppError('CONFLICT', 'splitBusy');
          return {
            ...payerActualReceiptSnapshot(debtor, originalCents, tipCents),
            choice: debtor.paymentOverpaymentChoice ?? null,
          };
        }
        let totals;
        try {
          totals = reconcileActualReceiptTransfers(
            originalCents,
            tipCents,
            debtor.paymentReceivedTransfers ?? [],
            input.choice,
            debtor.paymentRefunds ?? [],
          );
        } catch {
          throw new AppError('CONFLICT', 'splitBusy');
        }
        if (totals.excessCents <= 0) throw new AppError('BAD_REQUEST', 'splitBusy');
        const at = new Date().toISOString();
        const next = people.map((person, index) =>
          index === debtorIndex
            ? {
                ...person,
                paymentOverpaymentChoice: input.choice,
                paymentOverpaymentChoiceEvents: [
                  ...oldEvents,
                  { id: input.requestId, choice: input.choice, changedAt: at, changedByPersonId: input.personId },
                ],
              }
            : person,
        );
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: next as unknown as Prisma.InputJsonValue },
        });
        return { ...totals, choice: input.choice };
      });
    }),

  // 5.22.3: payer declares that money was ACTUALLY returned via bank.
  // No banking APIs, payments, QR, or inferred auto-refunds.
  confirmGuestOverpaymentRefund: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        debtorId: personIdSchema,
        requestId: z.string().uuid(),
        amountCents: z.number().int().min(1).max(MAX_MONEY_CENTS),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-verify', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, summary, paymentGroups } = requireGuestPayerReview(split, input.personId, input.personToken);
        const debtorIndex = people.findIndex((person) => person.id === input.debtorId);
        const group = paymentGroups?.find((row) => row.representativeId === input.debtorId && row.totalCents > 0);
        const entry = summary.find((row) => row.personIndex === debtorIndex && row.total > 0);
        if (debtorIndex < 0 || debtorIndex === split.paidByIndex || (paymentGroups ? !group : !entry)) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const debtor = people[debtorIndex]!;
        const expectedCents = group?.totalCents ?? entry!.total;
        const declaredTipCents = group?.tipCents ?? entry!.tip;
        const previous = debtor.paymentRefunds ?? [];
        const known = previous.find((record) => record.id === input.requestId);
        if (known) {
          if (known.amountCents !== input.amountCents) throw new AppError('CONFLICT', 'splitBusy');
          return payerActualReceiptSnapshot(debtor, expectedCents, declaredTipCents);
        }
        const current = payerActualReceiptSnapshot(debtor, expectedCents, declaredTipCents);
        if (
          debtor.paymentOverpaymentChoice !== 'refund' ||
          input.amountCents > current.refundDueCents ||
          current.refundDueCents <= 0
        ) {
          throw new AppError('BAD_REQUEST', 'splitBusy');
        }
        const confirmedAt = new Date().toISOString();
        const refunds = [
          ...previous,
          {
            id: input.requestId,
            amountCents: input.amountCents,
            confirmedAt,
            confirmedByPersonId: input.personId,
          },
        ];
        const totals = reconcileActualReceiptTransfers(
          expectedCents,
          declaredTipCents,
          debtor.paymentReceivedTransfers ?? [],
          'refund',
          refunds,
        );
        const next = people.map((person, index) =>
          index === debtorIndex ? { ...person, paymentRefunds: refunds } : person,
        );
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: next as unknown as Prisma.InputJsonValue },
        });
        return totals;
      });
    }),

  // Both manual payer actions retain an independent request history on the
  // DEBTOR (same GuestSplit row). The retry check runs inside guestTransaction,
  // so a serialization conflict re-reads the winning transaction's event.
  confirmGuestPaymentReceived: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        debtorId: personIdSchema,
        // New UI sends one UUID per intentional button press. Older API
        // clients can omit it; private server authorization is unchanged.
        requestId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-verify', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const outcome = await guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, summary, paymentGroups } = requireGuestPayerReview(split, input.personId, input.personToken);
        const debtorIndex = people.findIndex((person) => person.id === input.debtorId);
        const validGroup = paymentGroups?.find(
          (group) => group.representativeId === input.debtorId && group.totalCents > 0,
        );
        if (
          debtorIndex < 0 ||
          debtorIndex === split.paidByIndex ||
          (paymentGroups ? !validGroup : !summary.some((entry) => entry.personIndex === debtorIndex && entry.total > 0))
        ) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const debtor = people[debtorIndex]!;
        const previouslyHandled = debtor.paymentReceiptStatusRequests?.find((record) => record.id === input.requestId);
        if (previouslyHandled) {
          if (previouslyHandled.action !== 'confirm') throw new AppError('CONFLICT', 'splitBusy');
          return { verifiedAt: previouslyHandled.at, delivery: null };
        }
        // Never replace a previously recorded partial bank amount with a guessed full amount.
        if (debtor.paymentReceivedTransfers?.some((record) => !record.cancelledAt)) {
          throw new AppError('CONFLICT', 'splitBusy');
        }
        // 5.14: the payer attests money received, not the sender's own button.
        // A forgotten declaration never invents a participant action.
        if (debtor.paymentVerifiedAt) return { verifiedAt: debtor.paymentVerifiedAt, delivery: null };
        const verifiedAt = new Date().toISOString();
        const receiptName = (split.receiptData as { merchantName?: unknown }).merchantName;
        const amountCents = validGroup?.totalCents ?? summary.find((entry) => entry.personIndex === debtorIndex)?.total;
        if (!Number.isSafeInteger(amountCents) || amountCents! <= 0) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        // Persist the addressed notification in the same serialized transaction
        // as receipt verification. An idempotent repeat never duplicates it.
        const notification = {
          id: randomUUID(),
          payerName: people[split.paidByIndex]!.name,
          amountCents: amountCents!,
          receiptName: typeof receiptName === 'string' && receiptName.trim() ? receiptName.trim() : 'Чек',
          confirmedAt: verifiedAt,
        };
        const updated = people.map((person, index) =>
          index === debtorIndex
            ? {
                ...person,
                paymentVerifiedAt: verifiedAt,
                paymentVerifiedByPersonId: input.personId,
                paymentReceiptNotification: notification,
                ...(input.requestId
                  ? {
                      paymentReceiptStatusRequests: [
                        ...(person.paymentReceiptStatusRequests ?? []),
                        { id: input.requestId, action: 'confirm' as const, at: verifiedAt },
                      ].slice(-32),
                    }
                  : {}),
              }
            : person,
        );
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: updated as unknown as Prisma.InputJsonValue },
        });
        return {
          verifiedAt,
          delivery: {
            subscriptions: activeGuestPushSubscriptions(debtor.guestPushSubscriptions, debtor.personToken ?? ''),
            notificationId: notification.id,
          },
        };
      });
      // Dispatch only after commit. An idempotent repeat has delivery=null,
      // and a push outage never rolls back the durable unread notification.
      if (outcome.delivery) {
        try {
          await sendGuestReceiptPush(
            outcome.delivery.subscriptions,
            '/split/' + encodeURIComponent(input.token) + '/claim',
            outcome.delivery.notificationId,
          );
        } catch {
          // Push is optional. The 5.11 server-side inbox remains authoritative.
        }
      }
      return { verifiedAt: outcome.verifiedAt };
    }),

  // 5.13: only the actual payer may retract their OWN manual receipt
  // attestation. The sender's declaration and finalized debt are unchanged.
  // A new cancellation is committed with the status, never emitted before it.
  cancelGuestPaymentReceived: publicProcedure
    .input(
      z.strictObject({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        debtorId: personIdSchema,
        // New UI sends one UUID per intentional button press. Older API
        // clients can omit it; private server authorization is unchanged.
        requestId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-verify', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const outcome = await guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, summary, paymentGroups } = requireGuestPayerReview(split, input.personId, input.personToken);
        const debtorIndex = people.findIndex((person) => person.id === input.debtorId);
        const validGroup = paymentGroups?.find(
          (group) => group.representativeId === input.debtorId && group.totalCents > 0,
        );
        if (
          debtorIndex < 0 ||
          debtorIndex === split.paidByIndex ||
          (paymentGroups ? !validGroup : !summary.some((entry) => entry.personIndex === debtorIndex && entry.total > 0))
        ) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const debtor = people[debtorIndex]!;
        const previouslyHandled = debtor.paymentReceiptStatusRequests?.find((record) => record.id === input.requestId);
        if (previouslyHandled) {
          if (previouslyHandled.action !== 'cancel') throw new AppError('CONFLICT', 'splitBusy');
          return { cancelledAt: previouslyHandled.at, delivery: null };
        }
        // Retraction of an already retracted event is idempotent, and does not
        // generate a second notification, including retries from two tabs.
        if (!debtor.paymentVerifiedAt) {
          const last = debtor.paymentReceiptCancellationNotifications?.at(-1);
          if (!last) throw new AppError('BAD_REQUEST', 'paymentNotDeclared');
          return { cancelledAt: last.cancelledAt, delivery: null };
        }
        if (debtor.paymentRefunds?.length) {
          throw new AppError('CONFLICT', 'splitBusy');
        }
        if (debtor.paymentVerifiedByPersonId !== input.personId) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const amountCents = validGroup?.totalCents ?? summary.find((entry) => entry.personIndex === debtorIndex)?.total;
        if (!Number.isSafeInteger(amountCents) || amountCents! <= 0) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const cancelledAt = new Date().toISOString();
        const receiptName = (split.receiptData as { merchantName?: unknown }).merchantName;
        const event = {
          id: randomUUID(),
          // Retain the exact verified payer's stable identity: display names
          // are editable, and an audit needs more than a name and timestamp.
          payerPersonId: input.personId,
          payerName: people[split.paidByIndex]!.name,
          amountCents: amountCents!,
          receiptName: typeof receiptName === 'string' && receiptName.trim() ? receiptName.trim() : 'Чек',
          cancelledAt,
        };
        const prior = debtor.paymentReceiptCancellationNotifications ?? [];
        const updated = people.map((person, index) => {
          if (index !== debtorIndex) return person;
          const next = { ...person };
          delete next.paymentVerifiedAt;
          delete next.paymentVerifiedByPersonId;
          if (next.paymentReceivedTransfers) {
            next.paymentReceivedTransfers = next.paymentReceivedTransfers.map((record) =>
              record.cancelledAt ? record : { ...record, cancelledAt },
            );
            delete next.paymentOverpaymentChoice;
          }

          return {
            ...next,
            paymentReceiptCancellationNotifications: [...prior, event].slice(-20),
            ...(input.requestId
              ? {
                  paymentReceiptStatusRequests: [
                    ...(next.paymentReceiptStatusRequests ?? []),
                    { id: input.requestId, action: 'cancel' as const, at: cancelledAt },
                  ].slice(-32),
                }
              : {}),
          };
        });
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: updated as unknown as Prisma.InputJsonValue },
        });
        return {
          cancelledAt,
          delivery: {
            subscriptions: activeGuestPushSubscriptions(debtor.guestPushSubscriptions, debtor.personToken ?? ''),
            notificationId: event.id,
          },
        };
      });
      if (outcome.delivery) {
        try {
          await sendGuestReceiptPush(
            outcome.delivery.subscriptions,
            '/split/' + encodeURIComponent(input.token) + '/claim',
            outcome.delivery.notificationId,
            'cancelled',
          );
        } catch {
          // The signed-in / guest private inbox is still authoritative.
        }
      }
      return { cancelledAt: outcome.cancelledAt };
    }),

  // Read payer contact via a personal token only. The share token on its own
  // is a public receipt link and MUST NOT return the bank/phone. Use mutation
  // so the person's secret is sent in the request body, not the URL.
  getMyPayerSbpContact: publicProcedure
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: guestLinkSecretSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-sbp-read', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: shareLookupHash(input.token) },
        select: {
          expiresAt: true,
          people: true,
          paidByIndex: true,
          payerSbpPhone: true,
          payerSbpBankId: true,
        },
      });
      if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
      if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
      const people = split.people as GuestSessionPerson[];
      const payer = people[split.paidByIndex];
      if (!payer || payer.id !== input.personId || payer.personToken !== input.personToken) {
        throw new AppError('FORBIDDEN', 'invalidPersonToken');
      }
      if (payer.accountUserId) {
        // A personal link alone cannot read the registered account's profile.
        if (ctx.impersonating || ctx.session?.user?.id !== payer.accountUserId) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const profile = await ctx.db.user.findUnique({
          where: { id: payer.accountUserId },
          select: { sbpPhone: true, sbpBankId: true, suspendedAt: true, isPlaceholder: true },
        });
        if (!profile || profile.suspendedAt || profile.isPlaceholder) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        return { phone: profile.sbpPhone, bankId: profile.sbpBankId, profile: true as const };
      }
      return { phone: split.payerSbpPhone, bankId: split.payerSbpBankId };
    }),

  // A participant may learn the payer's destination only when this finalized
  // receipt actually requires THEM to reimburse the payer. A public share link,
  // the creator's account and a different guest's personal token are insufficient.
  getPayerSbpForReimbursement: publicProcedure
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: guestLinkSecretSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-sbp-reimbursement', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: shareLookupHash(input.token) },
        select: {
          expiresAt: true,
          status: true,
          people: true,
          paidByIndex: true,
          receiptData: true,
          summary: true,
          assignments: true,
          payerSbpPhone: true,
          payerSbpBankId: true,
        },
      });
      if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
      if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
      const { people, personIndex, paymentIndex } = requireGuestDebtor(split, input.personId, input.personToken);
      // A group is paid once by its representative, never every diner.
      if (personIndex !== paymentIndex) throw new AppError('FORBIDDEN', 'invalidPersonToken');
      // The verified account binding is the sole source for a registered
      // payer. No fallback to stale receipt contacts, even for an empty profile.
      const payer = people[split.paidByIndex];
      if (!payer) throw new AppError('FORBIDDEN', 'invalidPersonToken');
      let phone = split.payerSbpPhone;
      let bankId = split.payerSbpBankId;
      if (payer.accountUserId) {
        const profile = await ctx.db.user.findUnique({
          where: { id: payer.accountUserId },
          select: { sbpPhone: true, sbpBankId: true, suspendedAt: true, isPlaceholder: true },
        });
        phone = profile && !profile.suspendedAt && !profile.isPlaceholder ? profile.sbpPhone : null;
        bankId = profile && !profile.suspendedAt && !profile.isPlaceholder ? profile.sbpBankId : null;
      }
      return { phone: phone && bankId ? phone : null, bankId: phone && bankId ? bankId : null };
    }),

  // Only the person holding the payer's actual personal token may configure
  // where reimbursements go, even when the creator is somebody else.
  setMyPayerSbpContact: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: guestLinkSecretSchema,
        phone: z.string().max(24).nullable(),
        bankId: z.string().max(40).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-sbp-write', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const emptyPhone = input.phone === null || input.phone.trim() === '';
      const emptyBank = input.bankId === null || input.bankId.trim() === '';
      if (emptyPhone !== emptyBank) throw new AppError('BAD_REQUEST', 'sbpBankInvalid');
      const phone = emptyPhone ? null : normalizeSbpPhone(input.phone!);
      if (!emptyPhone && !phone) throw new AppError('BAD_REQUEST', 'sbpPhoneInvalid');
      if (!emptyBank && !isSupportedSbpBankId(input.bankId!)) {
        throw new AppError('BAD_REQUEST', 'sbpBankInvalid');
      }

      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: shareLookupHash(input.token) } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const payer = (split.people as GuestSessionPerson[])[split.paidByIndex];
        if (!payer || payer.id !== input.personId || payer.personToken !== input.personToken) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        if (payer.accountUserId) throw new AppError('FORBIDDEN', 'payerSbpProfileOnly');
        if (split.payerSbpPhone !== phone || split.payerSbpBankId !== (emptyBank ? null : input.bankId)) {
          await tx.guestSplit.update({
            where: { id: split.id },
            data: { payerSbpPhone: phone, payerSbpBankId: emptyBank ? null : input.bankId },
          });
        }
        return { success: true };
      });
    }),
});
