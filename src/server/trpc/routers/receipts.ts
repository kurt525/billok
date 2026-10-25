import { z } from 'zod';
import { AppError } from '@/server/lib/app-error';
import { Prisma } from '@/generated/prisma/client';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTRPCRouter, protectedProcedure, groupMemberProcedure } from '../init';
import { parseExtractedData } from '../../lib/json-schemas';
import { getExchangeRate, convertCents } from '../../lib/exchange-rates';
import { stripUndefined } from '../../lib/strip-undefined';
import { lockActiveGroup } from '../../lib/group-balances';
import { calculateManualReceiptTotals } from '@/lib/manual-receipt-split';
import { deleteUnusedSplitReceipts, removeReceiptFiles } from '../../lib/receipt-cleanup';

/**
 * Verify that a receipt exists and the user has access to it (via group membership).
 * When additional `include` fields are passed, the return type is widened since
 * Prisma cannot statically infer dynamic includes -- callers should cast as needed.
 */
async function verifyReceiptAccess(
  db: PrismaClient | Prisma.TransactionClient,
  receiptId: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  include?: Record<string, any>,
) {
  const receipt = await db.receipt.findUnique({
    where: { id: receiptId },
    // A placeholder removed from the group keeps their row (#284), which isn't membership
    include: { group: { include: { members: { where: { removedAt: null } } } }, ...include },
  });
  if (!receipt) throw new AppError('NOT_FOUND');
  if (receipt.group) {
    const isMember = receipt.group.members.some((m: { userId: string }) => m.userId === userId);
    if (!isMember) throw new AppError('FORBIDDEN');
  } else {
    // Ungrouped receipt: only the uploader can access it
    if (receipt.uploadedById !== userId) {
      throw new AppError('FORBIDDEN');
    }
  }
  return receipt;
}

export const receiptsRouter = createTRPCRouter({
  // Manual group receipts reuse ReceiptItem and ReceiptItemAssignment; never require OCR.
  createManual: groupMemberProcedure.input(z.object({ groupId: z.string() })).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      await lockActiveGroup(tx, input.groupId, 'archivedAddExpense');
      const receipt = await tx.receipt.create({
        data: {
          groupId: input.groupId,
          uploadedById: ctx.user.id,
          savedById: ctx.user.id,
          imagePath: '',
          originalName: 'billok-manual',
          mimeType: 'application/x-billok-manual',
          fileSize: 0,
          status: 'COMPLETED',
          extractedData: { merchantName: '', subtotal: 0, tax: 0, tip: 0, total: 0, currency: 'RUB' },
        },
      });
      return { receiptId: receipt.id };
    });
  }),

  getReceiptItems: protectedProcedure.input(z.object({ receiptId: z.string() })).query(async ({ ctx, input }) => {
    const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id, {
      items: {
        orderBy: { sortOrder: 'asc' },
        include: { assignments: true },
      },
    });

    type ReceiptItem = {
      id: string;
      name: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
      sortOrder: number;
      assignments: { id: string; receiptItemId: string; userId: string; shareOfItem: number }[];
    };

    const receiptWithItems = receipt as typeof receipt & { items: ReceiptItem[] };

    return {
      receipt: {
        id: receiptWithItems.id,
        status: receiptWithItems.status,
        imagePath: receiptWithItems.imagePath,
        isManual: receiptWithItems.originalName === 'billok-manual',
        creatorId: receiptWithItems.uploadedById,
        paidById: receiptWithItems.paidById,
        extractedData: receiptWithItems.extractedData as {
          merchantName?: string;
          date?: string;
          subtotal: number;
          tax: number;
          tip: number;
          total: number;
          currency: string;
        } | null,
      },
      items: receiptWithItems.items as ReceiptItem[],
    };
  }),

  updateItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string(),
        name: z.string().trim().min(1).max(200).optional(),
        quantity: z.number().int().min(1).optional(),
        unitPrice: z.number().int().min(0).optional(),
        totalPrice: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.receiptItem.findUnique({
        where: { id: input.itemId },
      });
      if (!item) throw new AppError('NOT_FOUND');
      await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

      const { itemId, ...data } = input;
      return ctx.db.receiptItem.update({
        where: { id: itemId },
        data: stripUndefined(data),
      });
    }),

  addItem: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        name: z.string().trim().min(1).max(200),
        quantity: z.number().int().min(1).default(1),
        unitPrice: z.number().int().min(0),
        totalPrice: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      const maxSort = await ctx.db.receiptItem.findFirst({
        where: { receiptId: input.receiptId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      return ctx.db.receiptItem.create({
        data: {
          receiptId: input.receiptId,
          name: input.name,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          totalPrice: input.totalPrice,
          sortOrder: (maxSort?.sortOrder ?? 0) + 1,
        },
      });
    }),

  deleteItem: protectedProcedure.input(z.object({ itemId: z.string() })).mutation(async ({ ctx, input }) => {
    const item = await ctx.db.receiptItem.findUnique({
      where: { id: input.itemId },
    });
    if (!item) throw new AppError('NOT_FOUND');
    await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

    await ctx.db.receiptItemAssignment.deleteMany({
      where: { receiptItemId: input.itemId },
    });
    await ctx.db.receiptItem.delete({ where: { id: input.itemId } });
    return { success: true };
  }),

  splitItem: protectedProcedure
    .input(
      z.object({
        itemId: z.string(),
        splitQuantity: z.number().int().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await ctx.db.receiptItem.findUnique({
        where: { id: input.itemId },
      });
      if (!item) throw new AppError('NOT_FOUND');
      await verifyReceiptAccess(ctx.db, item.receiptId, ctx.user.id);

      if (input.splitQuantity >= item.quantity) {
        throw new AppError('BAD_REQUEST', 'splitQuantityOverTotal');
      }

      return ctx.db.$transaction(async (tx) => {
        const current = await tx.receiptItem.findUniqueOrThrow({
          where: { id: input.itemId },
        });

        if (input.splitQuantity >= current.quantity) {
          throw new AppError('BAD_REQUEST', 'splitQuantityOverTotal');
        }

        const maxNewTotal = current.totalPrice - 1;
        if (maxNewTotal <= 0) {
          throw new AppError('BAD_REQUEST', 'itemPriceTooLowToSplit');
        }

        const newTotalPrice = Math.min(current.unitPrice * input.splitQuantity, maxNewTotal);
        const remainingQuantity = current.quantity - input.splitQuantity;
        const remainingTotalPrice = current.totalPrice - newTotalPrice;

        if (newTotalPrice <= 0 || remainingTotalPrice <= 0) {
          throw new AppError('BAD_REQUEST', 'splitPriceInvalid');
        }

        await tx.receiptItem.updateMany({
          where: {
            receiptId: current.receiptId,
            sortOrder: { gt: current.sortOrder },
          },
          data: { sortOrder: { increment: 1 } },
        });

        await tx.receiptItem.update({
          where: { id: input.itemId },
          data: {
            quantity: remainingQuantity,
            totalPrice: remainingTotalPrice,
          },
        });

        return tx.receiptItem.create({
          data: {
            receiptId: current.receiptId,
            name: current.name,
            quantity: input.splitQuantity,
            unitPrice: current.unitPrice,
            totalPrice: newTotalPrice,
            sortOrder: current.sortOrder + 1,
          },
        });
      });
    }),

  updateExtractedData: protectedProcedure
    .input(
      z.object({
        receiptId: z.string(),
        tax: z.number().int().min(0).optional(),
        tip: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const receipt = await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      const current = (receipt.extractedData ?? {}) as Record<string, unknown>;
      const updated = {
        ...current,
        ...(input.tax !== undefined ? { tax: input.tax } : {}),
        ...(input.tip !== undefined ? { tip: input.tip } : {}),
      };

      await ctx.db.receipt.update({
        where: { id: input.receiptId },
        data: { extractedData: updated as unknown as Prisma.InputJsonValue },
      });
      return { success: true };
    }),

  assignItemsAndCreateExpense: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        receiptId: z.string(),
        title: z.string().min(1).max(200),
        paidById: z.string(),
        tipOverride: z.number().int().min(0).optional(),
        assignments: z.array(
          z.object({
            receiptItemId: z.string(),
            userIds: z.array(z.string()).min(1),
            parts: z.array(z.number().int().min(1).max(10000)).optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Refuse an archived group before the checks and rate lookup below;
      // lockActiveGroup in the transaction is the check that holds (#289)
      const group = await ctx.db.group.findUnique({ where: { id: input.groupId } });
      if (group?.archivedAt) {
        throw new AppError('BAD_REQUEST', 'archivedCreateExpense');
      }

      const receipt = await ctx.db.receipt.findUnique({
        where: { id: input.receiptId },
        include: { items: true },
      });
      if (!receipt || receipt.status !== 'COMPLETED') {
        throw new AppError('BAD_REQUEST', 'receiptNotReady');
      }

      // Verify the caller has access to this receipt
      if (receipt.groupId) {
        // If already assigned to a group, it must match the target group
        if (receipt.groupId !== input.groupId) {
          throw new AppError('FORBIDDEN', 'receiptInOtherGroup');
        }
      } else {
        // Ungrouped receipt: only the uploader can use it
        if (receipt.uploadedById !== ctx.user.id) {
          throw new AppError('FORBIDDEN');
        }
      }

      const extractedData = parseExtractedData(receipt.extractedData);
      if (receipt.originalName === 'billok-manual') {
        const itemIds = new Set(receipt.items.map((item) => item.id));
        const assigned = input.assignments.map((assignment) => assignment.receiptItemId);
        if (
          !itemIds.size ||
          input.assignments.length !== itemIds.size ||
          new Set(assigned).size !== itemIds.size ||
          assigned.some((id) => !itemIds.has(id)) ||
          input.assignments.some(
            (a) =>
              new Set(a.userIds).size !== a.userIds.length ||
              (a.parts !== undefined && a.parts.length !== a.userIds.length),
          )
        ) {
          throw new AppError('BAD_REQUEST', 'receiptNotReady');
        }
      }

      const tax = extractedData.tax;
      const tip = input.tipOverride ?? extractedData.tip;

      // Build item map and verify all referenced items belong to this receipt
      const itemMap = new Map(receipt.items.map((item) => [item.id, item]));
      for (const a of input.assignments) {
        if (!itemMap.has(a.receiptItemId)) {
          throw new AppError('BAD_REQUEST', 'itemNotOnReceipt');
        }
      }

      // Calculate per-user item subtotals
      const userSubtotals = new Map<string, number>();

      if (receipt.originalName !== 'billok-manual')
        for (const assignment of input.assignments) {
          const item = itemMap.get(assignment.receiptItemId)!;

          const perPerson = Math.floor(item.totalPrice / assignment.userIds.length);
          const remainder = item.totalPrice - perPerson * assignment.userIds.length;

          for (const [i, userId] of assignment.userIds.entries()) {
            const amount = perPerson + (i < remainder ? 1 : 0);
            userSubtotals.set(userId, (userSubtotals.get(userId) ?? 0) + amount);
          }
        }

      // Proportionally distribute tax and tip using receipt subtotal as denominator.
      // This ensures each assigned item gets its fair share of tax/tip relative to
      // the full receipt subtotal, even when not all items are assigned.
      const actualSubtotal = Array.from(userSubtotals.values()).reduce((a, b) => a + b, 0);
      const receiptSubtotal = extractedData.subtotal > 0 ? extractedData.subtotal : actualSubtotal;
      const totalAmount =
        receipt.originalName === 'billok-manual'
          ? receipt.items.reduce((sum, item) => sum + item.totalPrice, 0) + tax + tip
          : actualSubtotal + tax + tip;

      const userTotals =
        receipt.originalName === 'billok-manual'
          ? calculateManualReceiptTotals({
              items: receipt.items,
              assignments: input.assignments.map((a) => ({
                receiptItemId: a.receiptItemId,
                people: a.userIds.map((userId, i) => ({ userId, parts: a.parts?.[i] ?? 1 })),
              })),
              creatorId: receipt.uploadedById ?? ctx.user.id,
              tax,
              tip,
            })
          : new Map<string, number>();
      let allocatedTotal = 0;
      const userEntries = Array.from(userSubtotals.entries());

      if (receipt.originalName !== 'billok-manual')
        for (const [i, [userId, itemTotal]] of userEntries.entries()) {
          const proportion = receiptSubtotal > 0 ? itemTotal / receiptSubtotal : 0;

          let userTax: number;
          let userTip: number;

          if (i === userEntries.length - 1) {
            // Last user gets remainder to prevent off-by-one
            const alreadyAllocated = allocatedTotal;
            const userTotal = totalAmount - alreadyAllocated;
            userTotals.set(userId, userTotal);
            allocatedTotal += userTotal;
          } else {
            userTax = Math.round(tax * proportion);
            userTip = Math.round(tip * proportion);
            const userTotal = itemTotal + userTax + userTip;
            userTotals.set(userId, userTotal);
            allocatedTotal += userTotal;
          }
        }

      // Save assignments in a single batch (replaces N×M individual upserts)
      const assignmentData = input.assignments.flatMap((a) =>
        a.userIds.map((userId, i) => ({
          receiptItemId: a.receiptItemId,
          userId,
          shareOfItem: a.parts?.[i] ?? 1,
        })),
      );

      // Currency conversion for receipt expenses
      const rawCurrency = extractedData.currency;
      const isValidIso = rawCurrency && /^[a-zA-Z]{3}$/.test(rawCurrency);
      const receiptCurrency = (isValidIso ? rawCurrency : group!.currency).toUpperCase();
      const groupCurrency = group!.currency.toUpperCase();
      let exchangeRate: number | null = null;
      let baseCurrencyAmount: number | null = null;

      if (receiptCurrency !== groupCurrency) {
        const receiptDate = extractedData.date?.slice(0, 10);
        exchangeRate = await getExchangeRate(receiptCurrency, groupCurrency, receiptDate);
        if (exchangeRate === null) {
          throw new AppError('BAD_REQUEST', 'receiptExchangeRateUnavailable');
        }
        baseCurrencyAmount = convertCents(totalAmount, exchangeRate);
      }

      // All writes in a single transaction for atomicity
      const expense = await ctx.db.$transaction(async (tx) => {
        await lockActiveGroup(tx, input.groupId, 'archivedCreateExpense');

        // Deleting the receipt from the pending list takes it off the group, and keeps it while
        // a claim session uses it (#318). Under its lock, that either waits for this expense
        // (and is refused) or finished first and is seen here
        const [current] = await tx.$queryRaw<{ groupId: string | null }[]>`
          SELECT "groupId" FROM "Receipt" WHERE "id" = ${input.receiptId} FOR SHARE`;
        if (!current || current.groupId !== receipt.groupId) {
          throw new AppError('CONFLICT', 'receiptRemovedFromGroup');
        }

        // Verify paidBy and all assignees are members of this group (after the lock,
        // so someone leaving meanwhile is either gone or waits for this, #279). A
        // placeholder removed from the group isn't (#284).
        const groupMembers = await tx.groupMember.findMany({
          where: { groupId: input.groupId, removedAt: null },
          select: { userId: true },
        });
        const memberIds = new Set(groupMembers.map((m) => m.userId));
        if (!memberIds.has(input.paidById)) {
          throw new AppError('BAD_REQUEST', 'payerNotMember');
        }
        for (const a of input.assignments) {
          for (const uid of a.userIds) {
            if (!memberIds.has(uid)) {
              throw new AppError('BAD_REQUEST', 'assigneeNotMember');
            }
          }
        }

        if (receipt.originalName === 'billok-manual') {
          // Remaining kopecks may belong to the creator who consumed no item.
          for (const userId of userTotals.keys()) {
            if (!memberIds.has(userId)) throw new AppError('BAD_REQUEST', 'assigneeNotMember');
          }
        }

        const exp = await tx.expense.create({
          data: {
            groupId: input.groupId,
            title: input.title,
            amount: totalAmount,
            currency: receiptCurrency,
            exchangeRate: exchangeRate ?? 1.0,
            baseCurrencyAmount,
            splitMode: 'ITEM',
            paidById: input.paidById,
            addedById: ctx.user.id,
            receiptId: input.receiptId,
            shares: {
              create: Array.from(userTotals.entries()).map(([userId, amount]) => ({
                userId,
                amount,
              })),
            },
          },
        });

        const itemIds = [...new Set(input.assignments.map((a) => a.receiptItemId))];
        await tx.receiptItemAssignment.deleteMany({
          where: { receiptItemId: { in: itemIds } },
        });
        await tx.receiptItemAssignment.createMany({
          data: assignmentData,
          skipDuplicates: true,
        });

        await tx.activityLog.create({
          data: {
            groupId: input.groupId,
            userId: ctx.user.id,
            type: 'EXPENSE_CREATED',
            entityId: exp.id,
            metadata: { title: input.title, amount: totalAmount, fromReceipt: true },
          },
        });

        return exp;
      });

      return expense;
    }),

  saveForLater: groupMemberProcedure
    .input(
      z.object({
        groupId: z.string(),
        receiptId: z.string(),
        paidById: z.string().nullable().optional(),
        assignments: z
          .array(
            z.object({
              receiptItemId: z.string(),
              userIds: z.array(z.string()).max(100),
              parts: z.array(z.number().int().min(1).max(10000)).optional(),
            }),
          )
          .max(200)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await verifyReceiptAccess(ctx.db, input.receiptId, ctx.user.id);

      await ctx.db.$transaction(async (tx) => {
        // Deleting it from the pending list takes it off the group and keeps it while a claim
        // session uses it (#318). Under its lock, that either waits for this save or is seen
        // here, and the access check above runs again on what the delete left
        await tx.$queryRaw`SELECT 1 FROM "Receipt" WHERE "id" = ${input.receiptId} FOR NO KEY UPDATE`;
        const receipt = await verifyReceiptAccess(tx, input.receiptId, ctx.user.id);
        if (receipt.status !== 'COMPLETED') {
          throw new AppError('BAD_REQUEST', 'receiptNotProcessed');
        }
        // Check it's not already linked to an expense
        const existing = await tx.expense.findUnique({
          where: { receiptId: input.receiptId },
        });
        if (existing) {
          throw new AppError('BAD_REQUEST', 'receiptAlreadyHasExpense');
        }

        const userIdsToValidate = new Set<string>();
        if (input.paidById) {
          userIdsToValidate.add(input.paidById);
        }
        for (const assignment of input.assignments ?? []) {
          for (const userId of assignment.userIds) {
            userIdsToValidate.add(userId);
          }
        }

        if (userIdsToValidate.size > 0) {
          const validMembers = await tx.groupMember.findMany({
            where: {
              groupId: input.groupId,
              userId: { in: Array.from(userIdsToValidate) },
              removedAt: null,
            },
            select: { userId: true },
          });
          const validMemberIds = new Set(validMembers.map((member) => member.userId));
          for (const userId of userIdsToValidate) {
            if (!validMemberIds.has(userId)) {
              throw new AppError('BAD_REQUEST', 'userNotGroupMember', { userId });
            }
          }
        }

        await tx.receipt.update({
          where: { id: input.receiptId },
          data: {
            groupId: input.groupId,
            savedById: ctx.user.id,
            ...(input.paidById !== undefined ? { paidById: input.paidById } : {}),
          },
        });

        if (input.assignments?.some((a) => a.parts && a.parts.length !== a.userIds.length)) {
          throw new AppError('BAD_REQUEST', 'receiptNotReady');
        }

        // Save partial assignments if provided (empty array clears existing)
        if (input.assignments) {
          // Validate that all receiptItemIds belong to this receipt
          if (input.assignments.length > 0) {
            const itemIds = input.assignments.map((a) => a.receiptItemId);
            const validItems = await tx.receiptItem.findMany({
              where: { id: { in: itemIds }, receiptId: input.receiptId },
              select: { id: true },
            });
            const validIds = new Set(validItems.map((i) => i.id));
            for (const id of itemIds) {
              if (!validIds.has(id)) {
                throw new AppError('BAD_REQUEST', 'itemIdNotOnReceipt', { id });
              }
            }
          }

          // Clear any existing assignments first
          await tx.receiptItemAssignment.deleteMany({
            where: {
              receiptItem: { receiptId: input.receiptId },
            },
          });

          // Create new assignments
          const seenAssignments = new Set<string>();
          const assignmentData: { receiptItemId: string; userId: string; shareOfItem: number }[] = [];
          for (const assignment of input.assignments) {
            for (const [i, userId] of assignment.userIds.entries()) {
              const key = `${assignment.receiptItemId}\u0000${userId}`;
              if (seenAssignments.has(key)) {
                continue;
              }
              seenAssignments.add(key);
              assignmentData.push({
                receiptItemId: assignment.receiptItemId,
                userId,
                shareOfItem: assignment.parts?.[i] ?? 1,
              });
            }
          }
          if (assignmentData.length > 0) {
            await tx.receiptItemAssignment.createMany({
              data: assignmentData,
            });
          }
        }
      });

      return { success: true };
    }),

  listPending: groupMemberProcedure.input(z.object({ groupId: z.string() })).query(async ({ ctx, input }) => {
    const receipts = await ctx.db.receipt.findMany({
      where: {
        groupId: input.groupId,
        status: 'COMPLETED',
        expense: null,
      },
      take: 200,
      orderBy: { createdAt: 'desc' },
    });

    return receipts.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      extractedData: r.extractedData as {
        merchantName?: string;
        date?: string;
        subtotal: number;
        tax: number;
        tip: number;
        total: number;
        currency: string;
      } | null,
    }));
  }),

  deletePending: protectedProcedure.input(z.object({ receiptId: z.string() })).mutation(async ({ ctx, input }) => {
    const receipt = await ctx.db.receipt.findUnique({
      where: { id: input.receiptId },
    });
    if (!receipt) {
      throw new AppError('NOT_FOUND');
    }
    // Only the uploader or the person who saved it can delete it
    const isUploader = receipt.uploadedById === ctx.user.id;
    const isSaver = receipt.savedById && receipt.savedById === ctx.user.id;
    if (!isUploader && !isSaver) {
      throw new AppError('FORBIDDEN');
    }

    // It leaves the group's pending list either way. A claim session made from it (the group
    // scan page's Share Link) still shows its image, so then it stays until no split uses it
    // and deleteUnusedSplitReceipts deletes it (#318); otherwise it's deleted now. The row
    // lock comes first, so an expense or a split being made from it meanwhile is seen.
    const imagePaths = await ctx.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<unknown[]>`SELECT 1 FROM "Receipt" WHERE "id" = ${input.receiptId} FOR UPDATE`;
      if (locked.length === 0) {
        throw new AppError('NOT_FOUND');
      }
      // Can't delete if already linked to expense
      const expense = await tx.expense.findUnique({ where: { receiptId: input.receiptId } });
      if (expense) {
        throw new AppError('BAD_REQUEST', 'receiptHasExpense');
      }
      await tx.receipt.update({ where: { id: input.receiptId }, data: { groupId: null } });
      return deleteUnusedSplitReceipts(tx, [input.receiptId]);
    });
    await removeReceiptFiles(imagePaths);

    return { success: true };
  }),
});
