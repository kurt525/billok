import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { AppError } from '@/server/lib/app-error';
import { Prisma, GuestSplitStatus } from '@/generated/prisma/client';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import { logger } from '../../lib/logger';
import { checkRateLimit, checkTokenRateLimit } from '../../lib/rate-limit';
import {
  checkClaimWriteRateLimit,
  checkSessionReadRateLimit,
  checkGuestPresenceHeartbeatLimit,
} from '../../lib/guest-session-limits';
import { getClientIp } from '../../lib/client-ip';
import { guestTransaction } from '../../lib/guest-transaction';
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
import { guestPortionAssignments, type GuestPortionAssignment } from '@/lib/guest-portions';
import { guestPartsConfirmationSnapshot } from '@/lib/guest-parts-confirmation';
import { guestKnownPartsBalance } from '@/lib/guest-known-parts';
import { guestPresenceState } from '@/lib/guest-presence';
import { hasDuplicateGuestNames, normalizeGuestName } from '@/lib/guest-session';
import { MAX_GUEST_NAME_LENGTH } from '@/lib/guest-name-limit';
import { MAX_MONEY_CENTS } from '@/lib/money';
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

function toPublicPerson({ name, groupSize, personToken }: GuestSessionPerson) {
  // Never includes personToken, join or saves: no guest procedure returns another person's token
  // (a client gets its own from joinSession; the admin export is the only place tokens leave in bulk).
  // hasJoined tells the claim page which names are still free to join as (the results page,
  // which reads getSplit, ignores it).
  return { name, groupSize: groupSize ?? 1, hasJoined: !!personToken };
}

function toPublicPeople(people: GuestSessionPerson[]) {
  return people.map(toPublicPerson);
}

// The claim page's view of the people: public fields plus each person's id, which it uses to
// target them (their index changes when someone listed before them is removed)
function toClaimPeople(people: IdentifiedGuestPerson[]) {
  return people.map((person) => ({ id: person.id, ...toPublicPerson(person), tipCents: person.tipCents ?? 0 }));
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

function cloneAssignments(assignments: GuestPortionAssignment[]) {
  return assignments.map((assignment) => ({
    ...assignment,
    personIndices: [...assignment.personIndices],
    ...(assignment.partsByPersonId ? { partsByPersonId: { ...assignment.partsByPersonId } } : {}),
  }));
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
  const due = summary.find((entry) => entry.personIndex === personIndex);
  if (!due || due.total <= 0) throw new AppError('FORBIDDEN', 'invalidPersonToken');
  return { people, person, personIndex };
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
  return { people, summary };
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
      const ip = getClientIp(ctx.headers);
      const maxGuest = parseInt(process.env.GUEST_RATE_LIMIT_MAX ?? '10', 10) || 10;
      const { allowed } = checkRateLimit(`guest-create-split:${ip}`, maxGuest, 60 * 60 * 1000);
      if (!allowed) {
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
            people: filteredPeople as unknown as Prisma.InputJsonValue,
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
        creatorName: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH),
        paidByName: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH),
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
      const ip = getClientIp(ctx.headers);
      const maxGuest = parseInt(process.env.GUEST_RATE_LIMIT_MAX ?? '10', 10) || 10;
      const { allowed } = checkRateLimit(`guest-create-claim:${ip}`, maxGuest, 60 * 60 * 1000);
      if (!allowed) {
        throw new AppError('TOO_MANY_REQUESTS', 'sessionsRateLimited');
      }

      const ownerId = await billokOwnerUserId(ctx);
      const creatorName = ownerId ? RESERVED_OWNER_NAME : input.creatorName.trim();
      const paidByName = input.paidByName.trim();

      // Duplicate guest rows are rejected; creator and payer references
      // intentionally point to the same row when the names match.
      if (hasDuplicateGuestNames(input.people ?? [])) {
        throw new AppError('CONFLICT', 'nameTaken');
      }
      const people: IdentifiedGuestPerson[] = [];
      const indexOf = (name: string) =>
        people.findIndex((p) => normalizeGuestName(p.name) === normalizeGuestName(name));
      for (const name of [...(input.people ?? []), creatorName, paidByName]) {
        if (indexOf(name) < 0) people.push({ id: randomUUID(), name: name.normalize('NFC') });
      }
      if (people.length > MAX_SESSION_PEOPLE) {
        throw new AppError('BAD_REQUEST', 'sessionFull', { max: MAX_SESSION_PEOPLE });
      }
      const paidByIndex = indexOf(paidByName);
      // A persistent participant ID identifies the creator even if names are
      // edited and the payer is a different person or appears earlier in the list.
      const organizerPersonId = people[indexOf(creatorName)]!.id;
      if (ownerId) {
        const idx = indexOf(RESERVED_OWNER_NAME);
        people[idx] = { ...people[idx]!, accountUserId: ownerId };
      }

      // Everyone else gets a token the first time they join this session
      let creator: { personId: string; personToken: string; name: string } | null = null;
      if (input.joinCreator) {
        const creatorIndex = indexOf(creatorName);
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
              personToken,
              ...(desiredGroupSize !== undefined ? { groupSize: desiredGroupSize } : {}),
            };
          } else {
            people.push({
              id: randomUUID(),
              name: RESERVED_OWNER_NAME,
              accountUserId: ownerId,
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
          (p) => !!p.accountUserId && normalizeGuestName(p.name) === RESERVED_OWNER_KEY,
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
          ...joinRecord,
          ...(input.groupSize != null ? { groupSize: input.groupSize } : {}),
        });
        await savePeople();

        return { personIndex: people.length - 1, personId, personToken, name };
      });
    }),

  // How a returning device finds its person: by the token it stored when it joined, not by
  // name, since anyone in the session can rename anyone. A mutation so the token travels in
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
        personToken: z.string().uuid(),
        // Who to rename, by id (see targetIndexOrThrow)
        targetId: personIdSchema,
        newName: z.string().trim().min(1).max(MAX_GUEST_NAME_LENGTH),
        groupSize: z.number().int().min(1).max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('edit-name', input.token, input.personToken)) {
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
        const isParticipant = people.some((p) => p.personToken === input.personToken);
        if (!isParticipant) throw new AppError('FORBIDDEN', 'notParticipant');
        const targetIndex = targetIndexOrThrow(people, input.targetId);

        const normalizedNew = normalizeGuestName(input.newName);
        const boundOwnerIndex = people.findIndex(
          (p) => !!p.accountUserId && normalizeGuestName(p.name) === RESERVED_OWNER_KEY,
        );
        if (
          (boundOwnerIndex >= 0 && normalizedNew === RESERVED_OWNER_KEY && targetIndex !== boundOwnerIndex) ||
          (boundOwnerIndex === targetIndex && input.newName.trim() !== RESERVED_OWNER_NAME)
        ) {
          throw new AppError('CONFLICT', 'nameTaken');
        }
        const conflict = people.findIndex((p, i) => i !== targetIndex && normalizeGuestName(p.name) === normalizedNew);
        if (conflict >= 0) throw new AppError('CONFLICT', 'nameTaken');

        people[targetIndex] = {
          ...people[targetIndex]!,
          name: input.newName.normalize('NFC').trim(),
          ...(input.groupSize != null ? { groupSize: input.groupSize } : {}),
        };
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

  // Every participant chooses only their own voluntary tip. This intentionally
  // does not yet alter shares or final totals: those are handled with the
  // subsequent personal-tip settlement and UI stages.
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
        const personIndex = people.findIndex((person) => person.personToken === input.personToken);
        if (personIndex < 0 || people[personIndex]?.id !== input.personId) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }

        // Setting the same amount twice, including the default zero, is a
        // no-op. Different devices are serialized through guestTransaction.
        if ((people[personIndex]!.tipCents ?? 0) !== input.tipCents) {
          const updated = people.map((person, index) =>
            index === personIndex ? { ...person, tipCents: input.tipCents } : person,
          );
          await tx.guestSplit.update({
            where: { id: session.id },
            data: { people: updated as unknown as Prisma.InputJsonValue },
          });
        }
        return { success: true, tipCents: input.tipCents };
      });
    }),

  // A guest may adjust only their own number of consumed portions. Keep the
  // existing claim/save semantics, but never trust name, person index or share
  // URL as authority to change another person's count.
  setMyItemParts: publicProcedure
    .input(
      z.object({
        token: shareTokenSchema,
        personId: personIdSchema,
        personToken: z.string().uuid(),
        itemIndex: z.number().int().min(0),
        parts: z.number().int().min(1).max(10000),
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
        if (session.status !== GuestSplitStatus.CLAIMING) {
          throw new AppError('BAD_REQUEST', 'sessionClosedToClaims');
        }
        const people = session.people as GuestSessionPerson[];
        const personIndex = people.findIndex(
          (person) => person.id === input.personId && person.personToken === input.personToken,
        );
        if (personIndex < 0) throw new AppError('FORBIDDEN', 'invalidPersonToken');
        const items = session.items as { totalPrice: number }[];
        if (input.itemIndex >= items.length) throw new AppError('BAD_REQUEST', 'invalidItemIndex');
        const assignments = cloneAssignments(session.assignments as GuestPortionAssignment[]);
        const target = assignments.find(
          (item) => item.itemIndex === input.itemIndex && item.personIndices.includes(personIndex),
        );
        if (!target) throw new AppError('PRECONDITION_FAILED', 'itemsUnassigned');
        if (target.partsByPersonId?.[input.personId] !== input.parts) {
          target.partsByPersonId = { ...target.partsByPersonId, [input.personId]: input.parts };
          enforceGuestKnownParts(
            items,
            people,
            assignments,
            parseExtractedData(session.receiptData).knownPartsByItem,
            false,
          );
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
          await tx.guestSplit.update({
            where: { id: session.id },
            data: {
              assignments: assignments as unknown as Prisma.InputJsonValue,
              ...invalidatePartsApproval(session.receiptData),
            },
          });
        }
        return { success: true, parts: input.parts };
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

        // Validate personToken belongs to ANY participant (allows claiming for others)
        const callerIndex = people.findIndex((p) => p.personToken === input.personToken);
        if (callerIndex < 0) {
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

        // Clean up empty assignments
        const cleanedAssignments = assignments.filter((a) => a.personIndices.length > 0);

        enforceGuestKnownParts(
          items,
          people,
          cleanedAssignments,
          parseExtractedData(session.receiptData).knownPartsByItem,
          false,
        );

        // The save key goes on the caller's person with this save, newest last
        const withSaveKey = save
          ? people.map((person, index) =>
              index === callerIndex ? { ...person, saves: [...callerSaves, save].slice(-SAVE_KEYS_KEPT) } : person,
            )
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
        knownPartsByItem?: Record<string, number>;
      },
      items: session.items as { name: string; quantity: number; unitPrice: number; totalPrice: number }[],
      // Everyone has an id by now (savePersonIds above)
      people: toClaimPeople(session.people as IdentifiedGuestPerson[]),
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
      const { person } = requireGuestDebtor(split, input.personId, input.personToken);
      return {
        declaredPaidAt: person.paymentDeclaredAt ?? null,
        verifiedAt: person.paymentDeclaredAt ? (person.paymentVerifiedAt ?? null) : null,
      };
    }),

  markMyPayment: publicProcedure
    .input(z.object({ token: shareTokenSchema, personId: personIdSchema, personToken: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!checkClaimWriteRateLimit('payment-declaration-write', input.token, input.personToken)) {
        throw new AppError('TOO_MANY_REQUESTS', 'tooManyRequests');
      }
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, person, personIndex } = requireGuestDebtor(split, input.personId, input.personToken);
        if (person.paymentDeclaredAt) {
          // Idempotent when a delayed retry or a second tab sends the same action.
          return { declaredPaidAt: person.paymentDeclaredAt };
        }
        const timestamp = new Date().toISOString();
        const updated = people.map((entry, index) =>
          index === personIndex ? { ...entry, paymentDeclaredAt: timestamp } : entry,
        );
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: updated as unknown as Prisma.InputJsonValue },
        });
        return { declaredPaidAt: timestamp };
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
      const { people, summary } = requireGuestPayerReview(split, input.personId, input.personToken);
      return {
        payments: summary
          .filter((entry) => entry.personIndex !== split.paidByIndex && entry.total > 0)
          .map((entry) => {
            const person = people[entry.personIndex]!;
            return {
              personId: person.id!,
              name: person.name,
              amount: entry.total,
              declaredPaidAt: person.paymentDeclaredAt ?? null,
              verifiedAt: person.paymentDeclaredAt ? (person.paymentVerifiedAt ?? null) : null,
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
      return guestTransaction(ctx.db, async (tx) => {
        const split = await tx.guestSplit.findUnique({ where: { shareToken: input.token } });
        if (!split) throw new AppError('NOT_FOUND', 'sessionNotFound');
        if (split.expiresAt < new Date()) throw new AppError('NOT_FOUND', 'sessionExpired');
        const { people, summary } = requireGuestPayerReview(split, input.personId, input.personToken);
        const debtorIndex = people.findIndex((person) => person.id === input.debtorId);
        if (
          debtorIndex < 0 ||
          debtorIndex === split.paidByIndex ||
          !summary.some((entry) => entry.personIndex === debtorIndex && entry.total > 0)
        ) {
          throw new AppError('FORBIDDEN', 'invalidPersonToken');
        }
        const debtor = people[debtorIndex]!;
        // Cannot attest an incoming transfer the debtor never declared.
        if (!debtor.paymentDeclaredAt) {
          throw new AppError('BAD_REQUEST', 'paymentNotDeclared');
        }
        if (debtor.paymentVerifiedAt) return { verifiedAt: debtor.paymentVerifiedAt };
        const verifiedAt = new Date().toISOString();
        const updated = people.map((person, index) =>
          index === debtorIndex ? { ...person, paymentVerifiedAt: verifiedAt } : person,
        );
        await tx.guestSplit.update({
          where: { id: split.id },
          data: { people: updated as unknown as Prisma.InputJsonValue },
        });
        return { verifiedAt };
      });
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
      const owed = summary.find((person) => person.personIndex === personIndex);
      if (!owed || owed.total <= 0) throw new AppError('FORBIDDEN', 'invalidPersonToken');
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
