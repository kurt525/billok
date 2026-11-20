import { AppError } from './app-error';
import { GuestSplitStatus, Prisma } from '@/generated/prisma/client';

type ReceiptRef = { id: string };

/**
 * Remove receipt records that no split references, under the caller's transaction.
 * A group or expense record's ownership and deletion constraints are checked by
 * the caller; related items and assignments are cascaded with the receipt.
 * Returns the number of records removed, without filesystem operations.
 */
export async function deleteReceiptsNoSplitUses(tx: Prisma.TransactionClient, receipts: ReceiptRef[]): Promise<number> {
  if (receipts.length === 0) return 0;
  const splits = await tx.guestSplit.findMany({
    where: { receiptId: { in: receipts.map((r) => r.id) } },
    select: { receiptId: true },
  });
  const used = new Set(splits.map((s) => s.receiptId));
  const unused = receipts.filter((r) => !used.has(r.id));
  if (unused.length > 0) {
    await tx.receipt.deleteMany({ where: { id: { in: unused.map((r) => r.id) } } });
  }
  return unused.length;
}

/**
 * Recheck orphan receipt records after the caller deletes referencing splits.
 * Row locks and the unchangedSince cutoff prevent accidental concurrent deletes.
 */
export async function deleteUnusedSplitReceipts(
  tx: Prisma.TransactionClient,
  receiptIds: string[],
  unchangedSince?: Date,
): Promise<number> {
  const ids = [...new Set(receiptIds)];
  if (ids.length === 0) return 0;
  // Two splits made from one receipt, deleted at the same moment, would otherwise each
  // still see the other and both keep it; so would a split and the group the receipt
  // came from. The checks below run once the other deletion has committed.
  await tx.$queryRaw`SELECT 1 FROM "Receipt" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
  const receipts = await tx.receipt.findMany({
    where: {
      id: { in: ids },
      groupId: null,
      expense: { is: null },
      ...(unchangedSince ? { updatedAt: { lt: unchangedSince } } : {}),
    },
    select: { id: true },
  });
  return deleteReceiptsNoSplitUses(tx, receipts);
}

/**
 * For a split being made from a receipt, in the transaction that saves it: locks the
 * receipt's row the way a foreign key would (`GuestSplit.receiptId` has none) and returns
 * its id, or `undefined` when the receipt is gone. A deletion of the receipt's last split
 * or of its group then either waits for the new split and sees it, or finishes first and
 * the split is saved without the receipt, instead of pointing at one deleted a moment later.
 *
 * Keep the original ownership and group-membership checks for a linked historical
 * receipt. BillOK no longer serves image files to anyone; the old upload route
 * is absent. This row lock still prevents a split from claiming a receipt
 * belonging to another group or another registered user.
 */
export async function lockReceiptForSplit(
  tx: Prisma.TransactionClient,
  receiptId: string | undefined,
  userId: string | undefined,
): Promise<string | undefined> {
  if (receiptId === undefined) return undefined;
  const [receipt] = await tx.$queryRaw<{ isGuest: boolean; uploadedById: string | null; groupId: string | null }[]>`
    SELECT "isGuest", "uploadedById", "groupId" FROM "Receipt" WHERE "id" = ${receiptId} FOR KEY SHARE`;
  if (!receipt) return undefined;
  if (receipt.isGuest) return receiptId;
  if (userId !== undefined && (await canOpenReceipt(tx, receipt, userId))) return receiptId;
  throw new AppError('NOT_FOUND', 'receiptNotFound');
}

// The access the group's pages give (`verifyReceiptAccess` in the receipts router): a group's
// receipt to its members, one outside a group to its uploader. The split procedures are public,
// so the caller's session (a JWT, valid until it expires) is checked against the account here:
// a suspended one, or one deleted into a placeholder, can't share a receipt
async function canOpenReceipt(
  tx: Prisma.TransactionClient,
  receipt: { uploadedById: string | null; groupId: string | null },
  userId: string,
): Promise<boolean> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { suspendedAt: true, isPlaceholder: true } });
  if (!user || user.suspendedAt !== null || user.isPlaceholder) return false;
  if (receipt.groupId === null) return receipt.uploadedById === userId;
  const member = await tx.groupMember.findUnique({
    where: { userId_groupId: { userId, groupId: receipt.groupId } },
  });
  return member !== null;
}

type Db = { $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> };

/**
 * Deletes only abandoned CLAIMING drafts past their expiry. FINALIZED receipts,
 * including items, allocations and payer-verified transfers, are durable history.
 * Recheck the status at DELETE to protect drafts finalized after selection.
 * Unused receipt records are removed only if no group, expense or split uses them.
 */
export async function deleteExpiredSplits(db: Db, batchSize: number): Promise<number> {
  return db.$transaction(async (tx) => {
    const expired = await tx.guestSplit.findMany({
      where: { status: GuestSplitStatus.CLAIMING, expiresAt: { lt: new Date() } },
      select: { id: true, receiptId: true },
      take: batchSize,
    });
    if (expired.length === 0) return 0;
    const { count } = await tx.guestSplit.deleteMany({
      where: {
        id: { in: expired.map((s) => s.id) },
        status: GuestSplitStatus.CLAIMING,
        expiresAt: { lt: new Date() },
      },
    });
    const receiptIds = expired.flatMap((s) => (s.receiptId ? [s.receiptId] : []));
    await deleteUnusedSplitReceipts(tx, receiptIds);
    return count;
  });
}

// Preserve a one-day grace period for detached records before garbage collection.
const UNUSED_RECEIPT_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const unusedReceiptCutoff = () => new Date(Date.now() - UNUSED_RECEIPT_MIN_AGE_MS);

// Receipts (as `r`) no group, expense or split uses, unchanged since the cutoff (#312):
// orphaned draft rows with no current references
const unusedReceipts = (cutoff: Date) => Prisma.sql`"Receipt" r
  WHERE r."updatedAt" < ${cutoff}
    AND r."groupId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "Expense" e WHERE e."receiptId" = r."id")
    AND NOT EXISTS (SELECT 1 FROM "GuestSplit" s WHERE s."receiptId" = r."id")`;

type RawDb = { $queryRaw<T>(query: Prisma.Sql): Promise<T> };

/** Counts unused receipt records; image files are no longer used. */
export async function countUnusedReceipts(db: RawDb): Promise<{ count: number }> {
  const [row] = await db.$queryRaw<{ count: number }[]>(
    Prisma.sql`SELECT count(*)::int AS "count" FROM ${unusedReceipts(unusedReceiptCutoff())}`,
  );
  return { count: row?.count ?? 0 };
}

/**
 * Deletes unused receipt rows in batches.
 * Each batch checks its receipts again under their row locks (`deleteUnusedSplitReceipts`),
 * so one saved to a group, made into an expense or split, or scanned again meanwhile
 * stays; it then no longer counts as unused, so the batches go on until none are left.
 * Returns how many were deleted.
 */
export async function deleteUnusedReceipts(db: Db, batchSize: number): Promise<number> {
  const cutoff = unusedReceiptCutoff();
  let deletedCount = 0;
  for (;;) {
    const deleted = await db.$transaction(async (tx) => {
      const picked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT r."id" FROM ${unusedReceipts(cutoff)} ORDER BY r."id" LIMIT ${batchSize}`,
      );
      if (picked.length === 0) return null;
      return deleteUnusedSplitReceipts(
        tx,
        picked.map((r) => r.id),
        cutoff,
      );
    });
    if (deleted === null) return deletedCount;
    deletedCount += deleted;
  }
}
