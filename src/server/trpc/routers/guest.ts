import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { AppError } from '@/server/lib/app-error';
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
import {
  deleteExpiredSplits,
  deleteUnusedSplitReceipts,
  lockReceiptForSplit,
  removeReceiptFiles,
} from '../../lib/receipt-cleanup';
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
import { hasDuplicateGuestNames, normalizeGuestName } from '@/lib/guest-session';
import { MAX_GUEST_NAME_LENGTH } from '@/lib/guest-name-limit';
import { MAX_MONEY_CENTS } from '@/lib/money';
import {
  aggregateReceiptPaymentGroups,
  receiptPaymentMemberships,
  setReceiptPaymentGroups,
} from '@/lib/receipt-payment-groups';
import { authorizeReceiptPersonEdit, appendDelegatedReceiptAudit } from '../../lib/guest-group-delegation';
import { normalizeSbpPhone, isSupportedSbpBankId } from '@/lib/sbp-banks';
import { checkJoinRateLimit } from '../../lib/guest-join-limit';
import {
  assignPersonIds,
  findTargetIndex,
  hasPersonIds,
  personIdSchema,
  type GuestSessionPerson,
  type IdentifiedGuestPerson,
} from '../../lib/guest-people';

/** 3.6.1: the owner's verified server account, never the supplied display name
 * or an impersonated session. ADMIN_EMAIL is the existing trusted owner account
 * configuration; checking the fetched user id prevents spoofing with a guest name.
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
  const ownerEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!userId || !ownerEmail || ctx.impersonating) return null;
  const account = await ctx.db.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, suspendedAt: true },
  });
  return account?.email?.trim().toLowerCase() === ownerEmail &&
    normalizeGuestName(account.name ?? '') === RESERVED_OWNER_KEY &&
    !account.suspendedAt
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

async function getCreatorPayerVenmoHandle(
  db: typeof import('@/server/db').db,
  userId: string | undefined | null,
  payerName: string | undefined,
): Promise<string | null> {
  if (!userId || !payerName) return null;
  const creator = await db.user.findUnique({
    where: { id: userId },
    select: { venmoUsername: true, name: true },
  });
  if (creator?.venmoUsername && creator.name && normalizeGuestName(creator.name) === normalizeGuestName(payerName)) {
    return creator.venmoUsername;
  }
  return null;
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

function toPublicPerson({ name, groupSize, personToken, accountUserId, visualColorId }: GuestSessionPerson) {
  // Public receipts never expose personal tokens or account identifiers.
  // An account-bound creator is occupied even if device storage was unavailable
  // when the receipt was created and there is no guest token yet.
  return {
    name,
    groupSize: groupSize ?? 1,
    hasJoined: !!personToken || !!accountUserId,
    // Only a trusted server-issued account binding qualifies, not a display
    // name, phone, share URL, or possession of a guest bearer credential.
    isRegistered: typeof accountUserId === 'string' && accountUserId.length > 0,
    ...(Number.isSafeInteger(visualColorId) && visualColorId! >= 0 ? { visualColorId } : {}),
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

// How many save keys claimItems remembers per person, newest last. A claim page has one save out
// at a time; after SAVE_ATTEMPTS sends it parks it and sends it again before its next save, for
// anyone (src/lib/claim-save.ts, #241). A key it's still sending, or has parked, drops out
// only if other tabs or devices holding the same person token (another tab of the browser, a
// personal link) make this many saves meanwhile. Kept by count, not age, to bound the people
// JSON, which every poll reads.
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
  const receipt = split.receiptData as { currency?: string; tax?: number; tip?: number; total?: number };
  const summary = split.summary as { personIndex: number; total: number; tip: number }[] | null;
  if (
    receipt.currency !== 'RUB' ||
    receipt.tax !== 0 ||
    receipt.tip !== 0 ||
    !Number.isSafeInteger(receipt.total) ||
    receipt.total! < 0 ||
    !Array.isArray(summary) ||
    summary.length !== people.length ||
    !people[split.paidByIndex] ||
    summary.some(
      (entry) =>
        !Number.isSafeInteger(entry.personIndex) ||
        entry.personIndex < 0 ||
        entry.personIndex >= people.length ||
        !Number.isSafeInteger(entry.total) ||
        entry.total < 0 ||
        !Number.isSafeInteger(entry.tip) ||
        entry.tip < 0,
    ) ||
    new Set(summary.map((entry) => entry.personIndex)).size !== people.length ||
    summary.reduce((sum, entry) => sum + entry.total, 0) !==
      receipt.total! + summary.reduce((sum, entry) => sum + entry.tip, 0)
  ) {
    throw new AppError('FORBIDDEN', 'invalidPersonToken');
  }
  const paymentGroups = finalizedPaymentGroups(people, split.paidByIndex, summary, receipt.total!);
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
  const receipt = split.receiptData as { currency?: string; tax?: number; tip?: number; total?: number };
  const summary = split.summary as { personIndex: number; total: number; tip: number }[] | null;
  if (
    receipt.currency !== 'RUB' ||
    receipt.tax !== 0 ||
    receipt.tip !== 0 ||
    !Number.isSafeInteger(receipt.total) ||
    receipt.total! < 0 ||
    !Array.isArray(summary) ||
    summary.length !== people.length ||
    summary.some(
      (entry) =>
        !Number.isSafeInteger(entry.personIndex) ||
        entry.personIndex < 0 ||
        entry.personIndex >= people.length ||
        !Number.isSafeInteger(entry.total) ||
        entry.total < 0 ||
        !Number.isSafeInteger(entry.tip) ||
        entry.tip < 0,
    ) ||
    new Set(summary.map((entry) => entry.personIndex)).size !== people.length ||
    summary.reduce((sum, entry) => sum + entry.total, 0) !==
      receipt.total! + summary.reduce((sum, entry) => sum + entry.tip, 0)
  ) {
    throw new AppError('FORBIDDEN', 'invalidPersonToken');
  }
  const paymentGroups = finalizedPaymentGroups(people, split.paidByIndex, summary, receipt.total!);
  return { people, summary, paymentGroups };
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
        logger.info(`${logPrefix}.cleanup`, { deletedCount });
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
      where: { shareToken: input.token },
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
    const imagePaths = await ctx.db.$transaction(async (tx) => {
      await tx.guestSplit.delete({ where: { id: input.id } });
      return deleteUnusedSplitReceipts(tx, split.receiptId ? [split.receiptId] : []);
    });
    await removeReceiptFiles(imagePaths);
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
            shareToken: s.shareToken,
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
        imagePath: receipt.imagePath,
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

  // Only an active signed-in user may create a bill; existing guest links stay public.
  createSplit: protectedProcedure
    .input(
      z.object({
        receiptId: receiptIdSchema.optional(),
        receiptData: receiptDataSchema,
        items: z.array(itemSchema).min(1).max(100),
        people: z
          .array(z.object({ name: z.string().trim().max(MAX_GUEST_NAME_LENGTH) }))
          .min(1)
          .max(100),
        assignments: z
          .array(
            z.object({
              itemIndex: z.number().int(),
              personIndices: z.array(z.number().int()),
            }),
          )
          .max(1000),
        paidByIndex: z.number().int().default(0),
        tipOverride: z.never().optional(), // no shared tip override
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkGuestReceiptCreationLimit(ctx.user.id)) {
        throw new AppError('TOO_MANY_REQUESTS', 'splitsRateLimited');
      }

      // Validate raw index bounds BEFORE filtering blank names
      for (const a of input.assignments) {
        if (a.itemIndex < 0 || a.itemIndex >= input.items.length) {
          throw new AppError('BAD_REQUEST', 'invalidItemIndexField', { index: a.itemIndex });
        }
        for (const pi of a.personIndices) {
          if (pi < 0 || pi >= input.people.length) {
            throw new AppError('BAD_REQUEST', 'invalidPersonIndex', { index: pi });
          }
        }
      }
      if (input.paidByIndex < 0 || input.paidByIndex >= input.people.length) {
        throw new AppError('BAD_REQUEST', 'invalidPaidByIndex', { index: input.paidByIndex });
      }

      // Filter out blank-name people and remap indices
      const indexMap = new Map<number, number>();
      const filteredPeople = input.people.filter((p, i) => {
        if (!p.name.trim()) return false;
        indexMap.set(i, indexMap.size);
        return true;
      });
      if (filteredPeople.length === 0) {
        throw new AppError('BAD_REQUEST', 'personNameRequired');
      }
      if (hasDuplicateGuestNames(filteredPeople.map((p) => p.name))) {
        throw new AppError('CONFLICT', 'nameTaken');
      }
      const remappedAssignments = input.assignments
        .map((a) => ({
          itemIndex: a.itemIndex,
          personIndices: a.personIndices.filter((pi) => indexMap.has(pi)).map((pi) => indexMap.get(pi)!),
        }))
        .filter((a) => a.personIndices.length > 0);
      const remappedPaidBy = indexMap.get(input.paidByIndex) ?? 0;

      // Note: second bounds-validation loop removed (Finding #13) — the remap above
      // only produces valid indices via indexMap filtering, making post-remap validation redundant.

      const summary = calculateSplitTotals({
        items: input.items,
        assignments: remappedAssignments,
        tax: 0,
        tip: 0,
        peopleCount: filteredPeople.length,
      });

      const summaryWithNames = summary.map((s) => ({
        ...s,
        name: filteredPeople[s.personIndex]?.name ?? `Person ${s.personIndex + 1}`,
      }));

      const payerVenmoHandle = await getCreatorPayerVenmoHandle(
        ctx.db,
        ctx.session?.user?.id,
        filteredPeople[remappedPaidBy]?.name,
      );

      const guestSplit = await ctx.db.$transaction(async (tx) => {
        const receiptId = await lockReceiptForSplit(tx, input.receiptId, ctx.session?.user?.id);
        return tx.guestSplit.create({
          data: {
            ...(receiptId !== undefined ? { receiptId, receiptShared: true } : {}),
            receiptData: input.receiptData as unknown as Prisma.InputJsonValue,
            items: input.items as unknown as Prisma.InputJsonValue,
            people: filteredPeople.map((person, index) => ({
              ...person,
              visualColorId: index,
            })) as unknown as Prisma.InputJsonValue,
            assignments: remappedAssignments as unknown as Prisma.InputJsonValue,
            summary: summaryWithNames as unknown as Prisma.InputJsonValue,
            paidByIndex: remappedPaidBy,
            payerVenmoHandle,
            userId: ctx.user.id,
            expiresAt: createExpiryDate(),
          },
        });
      });

      cleanupExpiredSplits(ctx.db, 'guest.split');

      logger.info('guest.split.created', {
        splitId: guestSplit.id,
        shareToken: guestSplit.shareToken.substring(0, 8) + '...',
        peopleCount: input.people.length,
        itemCount: input.items.length,
      });

      return { shareToken: guestSplit.shareToken };
    }),

  getSplit: publicProcedure.input(z.object({ token: shareTokenSchema })).query(async ({ ctx, input }) => {
    const split = await ctx.db.guestSplit.findUnique({
      where: { shareToken: input.token },
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

    return {
      id: split.id,
      shareToken: split.shareToken,
      receiptData: (() => {
        const { finalizationOrganizerUserId: _privateOrganizer, ...visible } = parseExtractedData(split.receiptData);
        void _privateOrganizer;
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
      payerVenmoHandle: split.payerVenmoHandle,
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
      const indexOf = (name: string) =>
        people.findIndex((p) => normalizeGuestName(p.name) === normalizeGuestName(name));
      if (usingGuestSlots) {
        // Always exactly one creator plus guestCount independently addressable
        // slots. The payer is a role on one of these rows, never an extra guest.
        people.push({
          id: randomUUID(),
          name: creatorName,
          accountUserId: ctx.user.id,
          ...(ownerId ? { reservedOwner: true } : {}),
        });
        for (let slot = 1; slot <= guestCount; slot++) {
          const preferredName = `Гость ${slot}`;
          const name = indexOf(preferredName) < 0 ? preferredName : `${preferredName} (гость)`;
          people.push({ id: randomUUID(), name, guestSlotNumber: slot });
        }
      } else {
        for (const name of [...(input.people ?? []), creatorName, paidByName]) {
          if (indexOf(name) < 0) people.push({ id: randomUUID(), name: name.normalize('NFC') });
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
        people[index] = { ...person, visualColorId: index };
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
        const person = { ...people[creatorIndex]!, personToken: randomUUID() };
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

      const claimPayerVenmoHandle = await getCreatorPayerVenmoHandle(
        ctx.db,
        ctx.session?.user?.id,
        people[paidByIndex]?.name,
      );

      const session = await ctx.db.$transaction(async (tx) => {
        const receiptId = await lockReceiptForSplit(tx, input.receiptId, ctx.session?.user?.id);
        return tx.guestSplit.create({
          data: {
            ...(receiptId !== undefined ? { receiptId, receiptShared: true } : {}),
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
            payerVenmoHandle: claimPayerVenmoHandle,
            status: GuestSplitStatus.CLAIMING,
            userId: ctx.user.id,
            expiresAt: createExpiryDate(),
          },
        });
      });

      cleanupExpiredSplits(ctx.db, 'guest.session');

      logger.info('guest.session.created', {
        sessionId: session.id,
        shareToken: session.shareToken.substring(0, 8) + '...',
        itemCount: expandedItems.length,
      });

      return { shareToken: session.shareToken, creator };
    }),

  /** 3.7.2: join one of N preallocated guest slots by *stable person id*.
   * The shareToken reveals available places but provides no ownership of a
   * taken place. This is intentionally separate from legacy name-based joining.
   * guestTransaction retries conflicting Repeatable Read writes to the same
   * GuestSplit row; both competing requests can never commit the same free slot.
   */
  joinGuestSlot: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        slotId: personIdSchema,
        name: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH),
        personToken: z.string().uuid().optional(),
        joinKey: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
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
        const session = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
            },
          });
        };
        const targetIndex = people.findIndex((p) => p.id === input.slotId && typeof p.guestSlotNumber === 'number');
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
          const token = own.personToken ?? randomUUID();
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
            replayed.id !== input.slotId ||
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
        const token = randomUUID();
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
      z.object({
        token: shareTokenSchema,
        name: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH),
        groupSize: z.number().int().min(1).max(20).optional(),
        // The token this device stored when it joined: whoever holds it is the caller. Only ever
        // used to find its holder, never given to anyone, so a removed person's old token
        // can't be attached to someone new.
        personToken: z.string().uuid().optional(),
        // An idempotency key the device made for this join. Replayable like Stripe's
        // Idempotency-Key: saved (with the normalized name) on the person the join creates or
        // first claims, a replay with the same key and name within JOIN_REPLAY_WINDOW_MS returns
        // that person, so a join whose response was lost doesn't end up at a taken name; the same
        // key with another name is refused. Tokens themselves are always minted here.
        joinKey: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkJoinRateLimit(input.token, input.name, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const ownerId = await billokOwnerUserId(ctx);
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: input.token },
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
          const personToken = previous?.personToken ?? randomUUID();
          const finalIndex = ownIndex >= 0 ? ownIndex : people.length;
          const desiredGroupSize = input.groupSize ?? previous?.groupSize;
          if (previous) {
            people[ownIndex] = {
              ...previous,
              name: RESERVED_OWNER_NAME,
              accountUserId: ownerId,
              reservedOwner: true,
              personToken,
              ...(desiredGroupSize !== undefined ? { groupSize: desiredGroupSize } : {}),
            };
          } else {
            people.push({
              id: randomUUID(),
              name: RESERVED_OWNER_NAME,
              accountUserId: ownerId,
              reservedOwner: true,
              personToken,
              ...(input.groupSize != null ? { groupSize: input.groupSize } : {}),
            });
          }
          // Don't revoke an organizer's approved parts snapshot just because
          // the same account reopened the receipt on another device.
          if (
            !previous ||
            renamedAnother ||
            idsMissing ||
            previous.name !== RESERVED_OWNER_NAME ||
            !previous.personToken ||
            previous.groupSize !== desiredGroupSize
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
          // Update groupSize on rejoin only if explicitly provided and different
          const newGroupSize =
            input.groupSize != null && input.groupSize !== (holder.groupSize ?? 1) ? input.groupSize : null;
          if (newGroupSize !== null) people[holderIndex] = { ...holder, groupSize: newGroupSize };
          if (newGroupSize !== null || idsMissing) await savePeople();
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

        const personToken = randomUUID();
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
            ...(input.groupSize != null ? { groupSize: input.groupSize } : {}),
          };
          await savePeople();
          return { personIndex: existingIndex, personId: existingPerson.id, personToken, name: existingPerson.name };
        }

        if (people.length >= MAX_SESSION_PEOPLE) {
          throw new AppError('BAD_REQUEST', 'sessionFull', { max: MAX_SESSION_PEOPLE });
        }

        const name = input.name.normalize('NFC').trim();
        const personId = randomUUID();
        people.push({
          id: personId,
          name,
          personToken,
          visualColorId: Math.max(people.length - 1, ...people.map((p) => p.visualColorId ?? -1)) + 1,
          ...joinRecord,
          ...(input.groupSize != null ? { groupSize: input.groupSize } : {}),
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
    .input(z.object({ token: shareTokenSchema, personToken: z.string().uuid() }))
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
        where: { shareToken: input.token },
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
      z.object({
        token: shareTokenSchema,
        // Optional only for the signed-in receipt creator: their own account
        // grants permission, no guest token belonging to somebody else needed.
        personToken: z.string().uuid().optional(),
        // Who to rename, by id (see targetIndexOrThrow)
        targetId: personIdSchema,
        newName: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH),
        groupSize: z.number().int().min(1).max(20).optional(),
      }),
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
          where: { shareToken: input.token },
        });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionFinalized');

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
        if (!isCreator && !isSelf) throw new AppError('FORBIDDEN', 'notParticipant');
        // The owner is not an editable guest, even if the creator of a
        // different bill happens to have a valid signed-in session.
        const targetAccount = people[targetIndex]!.accountUserId;
        if (targetAccount && targetAccount !== ctx.session?.user?.id) {
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
          ...(input.groupSize != null ? { groupSize: input.groupSize } : {}),
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

  removePerson: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personToken: z.string().uuid(),
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
          where: { shareToken: input.token },
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
        // No other person's guest token may eject the account-bound owner.
        if (people[targetIndex]?.accountUserId && people[targetIndex]?.personToken !== input.personToken) {
          throw new AppError('FORBIDDEN', 'notParticipant');
        }
        if (people.length <= 1) throw new AppError('BAD_REQUEST', 'cannotRemoveLastPerson');

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

        // Adjust paidByIndex
        let paidByIndex = session.paidByIndex;
        if (targetIndex === paidByIndex) {
          paidByIndex = 0;
        } else if (targetIndex < paidByIndex) {
          paidByIndex--;
        }

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
        personToken: z.string().uuid(),
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
          where: { shareToken: input.token },
        });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (session.status !== GuestSplitStatus.CLAIMING) throw new AppError('BAD_REQUEST', 'sessionFinalized');

        const people = session.people as GuestSessionPerson[];
        const isParticipant = people.some((p) => p.personToken === input.personToken);
        if (!isParticipant) throw new AppError('FORBIDDEN', 'notParticipant');

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
        personToken: z.string().uuid(),
        tipCents: z.number().int().min(0).max(MAX_MONEY_CENTS),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('personal-tip', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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

  // A guest adjusts their own portions, or a group representative adjusts
  // portions for a member of their current validated payment group. Preserve
  // the same atomic save and parts-balance semantics for both callers.
  setMyItemParts: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: z.string().uuid(),
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
        const session = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
          personToken: z.string().uuid(),
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
      if (!checkClaimWriteRateLimit('claim', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'claimRateLimited');
      }

      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: input.token },
        });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');

        const people = session.people as GuestSessionPerson[];
        const items = session.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[];

        // Validate an actual participant token; in grouped receipts, edits
        // for others require the current group's representative credential.
        const callerIndex = people.findIndex((p) => p.personToken === input.personToken);
        if (callerIndex < 0) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        // In receipts containing payment groups, every cross-person claim
        // must be authorized against the current group snapshot, including
        // retries after a representative has been replaced.
        const groupedReceipt = people.some((p) => p.paymentGroupRepresentativeId !== undefined);
        if (groupedReceipt) {
          authorizeReceiptPersonEdit(people, session.paidByIndex, input.personToken, input.personId, true);
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
        const { delegated } = authorizeReceiptPersonEdit(
          people,
          session.paidByIndex,
          input.personToken,
          input.personId,
          true,
        );

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
        personToken: z.string().uuid(),
        deviceId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkGuestPresenceHeartbeatLimit(input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const session = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
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
        const session = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
        const personToken = randomUUID();
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
        where: { shareToken: input.token },
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
      where: { shareToken: input.token },
    });
    if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
    if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
    if (!hasPersonIds(session.people as GuestSessionPerson[])) session = await savePersonIds(ctx.db, session.id);

    const parsedData = parseExtractedData(session.receiptData);
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

    let receiptImagePath: string | null = null;
    if (session.receiptId) {
      const receipt = await ctx.db.receipt.findUnique({
        where: { id: session.receiptId },
        select: { imagePath: true },
      });
      receiptImagePath = receipt?.imagePath ?? null;
    }

    return {
      id: session.id,
      shareToken: session.shareToken,
      status: session.status,
      receiptData: (() => {
        const { finalizationOrganizerUserId: _privateOrganizer, ...visible } = parseExtractedData(session.receiptData);
        void _privateOrganizer;
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
      payerVenmoHandle: session.payerVenmoHandle,
      isCreator: !!session.userId && session.userId === ctx.session?.user?.id,
      canFinalize: canFinalizeGuestSession(
        session.userId,
        parseExtractedData(session.receiptData),
        ctx.session?.user?.id,
      ),
      hasFinalizationOrganizer: typeof parseExtractedData(session.receiptData).finalizationOrganizerUserId === 'string',
      receiptImagePath,
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
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        !checkTokenRateLimit('payment-group-edit:' + JSON.stringify([input.token, ctx.user.id]), 30, 60_000).allowed
      ) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
        if (!session) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (session.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        if (!session.userId || session.userId !== ctx.user.id || ctx.impersonating) {
          throw new AppError('FORBIDDEN', 'notParticipant');
        }
        if (session.status !== GuestSplitStatus.CLAIMING) {
          throw new AppError('BAD_REQUEST', 'sessionFinalized');
        }
        const existing = assignPersonIds(session.people as GuestSessionPerson[]);
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
        const session = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
        const session = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
        const session = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
        const session = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
          personToken: z.string().uuid().optional(),
          tipOverride: z.never().optional(), // no shared tip override
        })
        .refine((value) => (value.personId === undefined) === (value.personToken === undefined), {
          message: 'Person ID and personal token must be supplied together',
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const { shareToken, finalizeLog } = await guestTransaction(ctx.db, async (tx) => {
        const session = await tx.guestSplit.findUnique({
          where: { shareToken: input.token },
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

        // A receipt creator must have acknowledged this exact set of claims
        // in the same repeatable-read snapshot used to produce the final shares.
        if (
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

        await tx.guestSplit.update({
          where: { id: session.id },
          data: {
            status: GuestSplitStatus.FINALIZED,
            summary: summaryWithNames as unknown as Prisma.InputJsonValue,
            assignments: assignments as unknown as Prisma.InputJsonValue,
          },
        });

        return {
          shareToken: session.shareToken,
          finalizeLog: { sessionId: session.id, peopleCount: people.length, itemCount: items.length },
        };
      });

      // Log only once the transaction has committed; the callback may run more than once.
      logger.info('guest.session.finalized', finalizeLog);
      return { shareToken };
    }),

  // The declaration is NOT a bank transaction and never means the payer has
  // received money. A person's own token is needed both to read and to write.
  getMyPaymentDeclaration: publicProcedure
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-read', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
        select: { expiresAt: true, status: true, people: true, paidByIndex: true, receiptData: true, summary: true },
      });
      if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
      if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
      const { people, personIndex, paymentIndex, paymentPerson, amountCents } = requireGuestDebtor(
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
        personToken: z.string().uuid(),
        endpoint: z.string().max(2048),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-read', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
        select: { expiresAt: true, status: true, people: true, paidByIndex: true, receiptData: true, summary: true },
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
        personToken: z.string().uuid(),
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
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
        personToken: z.string().uuid(),
        endpoint: z.string().max(2048),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!validGuestPushEndpoint(input.endpoint)) throw new AppError('BAD_REQUEST');
      if (!checkClaimWriteRateLimit('guest-push-subscription', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
        personToken: z.string().uuid(),
        notificationId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-write', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
    .input(z.strictObject({ token: shareTokenSchema, personId: personIdSchema, personToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-write', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
        if (paymentPerson.paymentDeclaredAt || paymentPerson.paymentVerifiedAt) {
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
            ? { ...entry, paymentDeclaredAt: timestamp, paymentDeclaredAmountCents: amountCents }
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
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-write', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, paymentPerson, paymentIndex, personIndex } = requireGuestDebtor(
          split,
          input.personId,
          input.personToken,
        );
        if (paymentIndex !== personIndex) throw new AppError('FORBIDDEN', 'notParticipant');
        if (paymentPerson.paymentVerifiedAt) {
          throw new AppError('BAD_REQUEST', 'paymentAlreadyVerified');
        }
        if (!paymentPerson.paymentDeclaredAt) {
          return { declaredPaidAt: null, verifiedAt: null };
        }
        const updated = people.map((entry, index) => {
          if (index !== paymentIndex) return entry;
          const cleared = { ...entry };
          delete cleared.paymentDeclaredAt;
          delete cleared.paymentDeclaredAmountCents;
          delete cleared.paymentVerifiedAt;
          delete cleared.paymentVerifiedByPersonId;
          return cleared;
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
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-review', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
        select: { expiresAt: true, status: true, people: true, paidByIndex: true, receiptData: true, summary: true },
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
                  declaredPaidAt: representative.paymentDeclaredAt ?? null,
                  verifiedAt: representative.paymentVerifiedAt ?? null,
                  verifiedByPersonId: representative.paymentVerifiedAt
                    ? (representative.paymentVerifiedByPersonId ?? null)
                    : null,
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
                  declaredPaidAt: person.paymentDeclaredAt ?? null,
                  verifiedAt: person.paymentVerifiedAt ?? null,
                  verifiedByPersonId: person.paymentVerifiedAt ? (person.paymentVerifiedByPersonId ?? null) : null,
                };
              }),
      };
    }),

  confirmGuestPaymentReceived: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: z.string().uuid(),
        debtorId: personIdSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-verify', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const outcome = await guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
        personToken: z.string().uuid(),
        debtorId: personIdSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-payment-verify', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const outcome = await guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
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
        // Retraction of an already retracted event is idempotent, and does not
        // generate a second notification, including retries from two tabs.
        if (!debtor.paymentVerifiedAt) {
          const last = debtor.paymentReceiptCancellationNotifications?.at(-1);
          if (!last) throw new AppError('BAD_REQUEST', 'paymentNotDeclared');
          return { cancelledAt: last.cancelledAt, delivery: null };
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
          return {
            ...next,
            paymentReceiptCancellationNotifications: [...prior, event].slice(-20),
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
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-sbp-read', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
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
      return { phone: split.payerSbpPhone, bankId: split.payerSbpBankId };
    }),

  // A participant may learn the payer's destination only when this finalized
  // receipt actually requires THEM to reimburse the payer. A public share link,
  // the creator's account and a different guest's personal token are insufficient.
  getPayerSbpForReimbursement: publicProcedure
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payer-sbp-reimbursement', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
        select: {
          expiresAt: true,
          status: true,
          people: true,
          paidByIndex: true,
          receiptData: true,
          summary: true,
          payerSbpPhone: true,
          payerSbpBankId: true,
        },
      });
      if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
      if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
      if (split.status !== GuestSplitStatus.FINALIZED) {
        throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
      }
      const people = split.people as GuestSessionPerson[];
      const personIndex = people.findIndex(
        (person) => person.id === input.personId && person.personToken === input.personToken,
      );
      if (personIndex < 0) throw new AppError('FORBIDDEN', 'invalidPersonToken');
      if (personIndex === split.paidByIndex) throw new AppError('FORBIDDEN', 'invalidPersonToken');
      const receipt = split.receiptData as { currency?: string; tax?: number; tip?: number; total?: number };
      const summary = split.summary as { personIndex: number; total: number; tip: number }[] | null;
      // Fail closed if stale or malformed settlement sums cannot be reconciled.
      if (
        receipt.currency !== 'RUB' ||
        receipt.tax !== 0 ||
        receipt.tip !== 0 ||
        !Number.isSafeInteger(receipt.total) ||
        !Array.isArray(summary) ||
        summary.length !== people.length ||
        summary.some(
          (person) =>
            !Number.isSafeInteger(person.total) ||
            person.total < 0 ||
            !Number.isSafeInteger(person.tip) ||
            person.tip < 0,
        ) ||
        summary.reduce((sum, person) => sum + person.total, 0) !==
          receipt.total! + summary.reduce((sum, person) => sum + person.tip, 0)
      ) {
        throw new AppError('FORBIDDEN', 'invalidPersonToken');
      }
      const groupPayments = finalizedPaymentGroups(people, split.paidByIndex, summary, receipt.total!);
      if (groupPayments) {
        const payment = groupPayments.find((group) => group.representativeId === input.personId);
        // A group is paid once by its representative, not by every diner.
        if (!payment || payment.totalCents <= 0) throw new AppError('FORBIDDEN', 'invalidPersonToken');
      } else {
        const owed = summary.find((person) => person.personIndex === personIndex);
        if (!owed || owed.total <= 0) throw new AppError('FORBIDDEN', 'invalidPersonToken');
      }
      return {
        phone: split.payerSbpPhone && split.payerSbpBankId ? split.payerSbpPhone : null,
        bankId: split.payerSbpPhone && split.payerSbpBankId ? split.payerSbpBankId : null,
      };
    }),

  // Only the person holding the payer's actual personal token may configure
  // where reimbursements go, even when the creator is somebody else.
  setMyPayerSbpContact: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: z.string().uuid(),
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
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const payer = (split.people as GuestSessionPerson[])[split.paidByIndex];
        if (!payer || payer.id !== input.personId || payer.personToken !== input.personToken) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        if (split.payerSbpPhone !== phone || split.payerSbpBankId !== (emptyBank ? null : input.bankId)) {
          await tx.guestSplit.update({
            where: { id: split.id },
            data: { payerSbpPhone: phone, payerSbpBankId: emptyBank ? null : input.bankId },
          });
        }
        return { success: true };
      });
    }),

  setPayerVenmoHandle: protectedProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        handle: z.string().max(50).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Keyed by the client-sent share token before it's checked, so it goes in the capped token store
      const { allowed } = checkTokenRateLimit(`venmo-handle:${ctx.user.id}:${input.token}`, 10, 60 * 1000);
      if (!allowed) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }

      const split = await ctx.db.guestSplit.findUnique({
        where: { shareToken: input.token },
        select: { id: true, userId: true, expiresAt: true },
      });
      if (!split) {
        throw new AppError('NOT_FOUND', 'splitNotFound');
      }
      if (split.expiresAt < new Date()) {
        throw new AppError('NOT_FOUND', 'splitExpired');
      }
      if (split.userId !== ctx.user.id) {
        throw new AppError('FORBIDDEN', 'onlyCreatorSetsVenmo');
      }

      await ctx.db.guestSplit.update({
        where: { id: split.id },
        data: { payerVenmoHandle: input.handle?.trim() || null },
      });

      return { success: true };
    }),
});
