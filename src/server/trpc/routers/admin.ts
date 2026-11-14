import { z } from 'zod';
import { requireOwner } from '@/server/lib/owner-access';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import { type AdminAction, type PrismaClient, GuestSplitStatus, Prisma } from '@/generated/prisma/client';
import nodemailer from 'nodemailer';
import fs from 'fs';
import * as fsp from 'fs/promises';
import path from 'path';
import { getRecentLogs } from '@/server/lib/logger';
import { deleteGroupWithData } from '@/server/lib/group-delete';
import { lockGroupMembers } from '@/server/lib/group-balances';
import {
  countUnusedReceipts,
  deleteExpiredSplits,
  deleteUnusedReceipts,
  removeReceiptFiles,
} from '@/server/lib/receipt-cleanup';
import { getBuildInfo } from '@/server/lib/build-info';
import { REGISTRATION_MODES, readRegistrationMode } from '@/server/lib/registration-mode';
import { activeSystemInviteWindow, SYSTEM_INVITE_TTL_MS } from '@/server/lib/system-invite-lifetime';
import { totalsInGroupCurrency } from '@/server/lib/group-expense-totals';
import { listOwnerRegisteredUsers, changeRegisteredUserSuspension } from '@/server/lib/owner-user-admin';
import { ownerSessionFingerprint, consumeOwnerPasskeyActionProof } from '@/server/lib/owner-passkey-action-approval';

const serverStartTime = new Date();
const { version: cachedVersion, commitSha: cachedCommitSha } = getBuildInfo();

// All admin procedures, including the 6.11 registered-user page,
// share one owner policy. Impersonation never grants owner authority.
const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.impersonating) throw new AppError('FORBIDDEN', 'adminRequired');
  await requireOwner(ctx.db, ctx.user.id);
  return next({ ctx });
});
const ownerUsersProcedure = adminProcedure;

export { adminProcedure };

/** Reusable helper to log an admin action to the audit log. */
export async function logAdminAction(
  db: PrismaClient,
  adminId: string,
  action: AdminAction,
  targetId?: string | null,
  metadata?: Record<string, unknown> | null,
) {
  await db.adminAuditLog.create({
    data: {
      adminId,
      action,
      ...(targetId != null ? { targetId } : {}),
      ...(metadata !== null && metadata !== undefined ? { metadata: metadata as Prisma.InputJsonValue } : {}),
    },
  });
}

export const adminRouter = createTRPCRouter({
  ownerRegisteredUsers: ownerUsersProcedure
    .input(
      z.object({
        cursor: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(30).default(20),
        search: z.string().max(100).optional(),
        status: z.enum(['all', 'active', 'suspended', 'pending']).default('all'),
        sortBy: z.enum(['name', 'email', 'createdAt']).default('createdAt'),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
      }),
    )
    .query(({ ctx, input }) => listOwnerRegisteredUsers(ctx.db, ctx.user.id, input)),

  ownerSetUserSuspended: ownerUsersProcedure
    .input(
      z.object({
        userId: z.string().min(1).max(128),
        suspend: z.boolean(),
        approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      }),
    )
    .mutation(({ ctx, input }) =>
      changeRegisteredUserSuspension({
        db: ctx.db,
        ownerId: ctx.user.id,
        userId: input.userId,
        suspend: input.suspend,
        approvalToken: input.approvalToken,
        sessionHash: ownerSessionFingerprint(ctx.headers),
      }),
    ),

  getImpersonationStatus: publicProcedure.query(({ ctx }) => {
    return {
      isImpersonating: !!ctx.impersonating,
      targetName: ctx.impersonating?.targetName ?? null,
      targetEmail: ctx.impersonating?.targetEmail ?? null,
    };
  }),

  getAuditLog: adminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        action: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.adminAuditLog.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        ...(input.action ? { where: { action: input.action as AdminAction } } : {}),
        orderBy: { createdAt: 'desc' },
        include: {
          admin: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return {
        items: items.map((item) => ({
          id: item.id,
          action: item.action,
          targetId: item.targetId,
          metadata: item.metadata as Record<string, unknown> | null,
          adminName: item.admin.name ?? item.admin.email,
          adminEmail: item.admin.email,
          createdAt: item.createdAt,
        })),
        nextCursor,
      };
    }),

  getSystemHealth: adminProcedure.query(async ({ ctx }) => {
    // DB status
    let dbStatus: 'connected' | 'disconnected' = 'disconnected';
    try {
      await ctx.db.$queryRaw`SELECT 1`;
      dbStatus = 'connected';
    } catch {
      // disconnected
    }

    return {
      dbStatus,
      version: cachedVersion,
      commitSha: cachedCommitSha,
      serverStartTime: serverStartTime.toISOString(),
      uptime: Math.floor((Date.now() - serverStartTime.getTime()) / 1000),
    };
  }),

  listUsers: adminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        search: z.string().max(200).optional(),
        sortBy: z.enum(['name', 'email', 'groupCount', 'createdAt']).default('createdAt'),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        status: z.enum(['all', 'active', 'suspended', 'placeholder']).default('all'),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Build where clause
      const where: Prisma.UserWhereInput = {};

      if (input.status === 'active') {
        where.suspendedAt = null;
        where.isPlaceholder = false;
      } else if (input.status === 'suspended') {
        where.suspendedAt = { not: null };
      } else if (input.status === 'placeholder') {
        where.isPlaceholder = true;
      }

      if (input.search) {
        where.OR = [
          { name: { contains: input.search, mode: 'insensitive' } },
          { email: { contains: input.search, mode: 'insensitive' } },
          { placeholderName: { contains: input.search, mode: 'insensitive' } },
        ];
      }

      type UserOrderBy = Prisma.UserOrderByWithRelationInput;
      const dir = input.sortDirection;
      const idTiebreaker: UserOrderBy = { id: dir };
      let orderBy: UserOrderBy[];
      switch (input.sortBy) {
        case 'name':
          orderBy = [
            { name: { sort: dir, nulls: dir === 'asc' ? 'last' : 'first' } },
            { placeholderName: dir },
            idTiebreaker,
          ];
          break;
        case 'email':
          orderBy = [{ email: dir }, idTiebreaker];
          break;
        case 'groupCount':
          orderBy = [{ groupMembers: { _count: dir } }, idTiebreaker];
          break;
        case 'createdAt':
        default:
          orderBy = [{ createdAt: dir }, idTiebreaker];
          break;
      }

      const isFirstPage = !input.cursor;
      const [users, ...counts] = await Promise.all([
        ctx.db.user.findMany({
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
          where,
          select: {
            id: true,
            name: true,
            email: true,
            isPlaceholder: true,
            placeholderName: true,
            suspendedAt: true,
            createdAt: true,
            _count: {
              select: { groupMembers: true },
            },
          },
          orderBy,
        }),
        ...(isFirstPage ? [ctx.db.user.count({ where })] : []),
      ]);

      let nextCursor: string | undefined;
      if (users.length > input.limit) {
        const next = users.pop();
        nextCursor = next?.id;
      }

      return {
        users: users.map((u) => ({
          id: u.id,
          name: u.isPlaceholder ? u.placeholderName : u.name,
          email: u.email,
          isPlaceholder: u.isPlaceholder,
          isSuspended: u.suspendedAt !== null,
          suspendedAt: u.suspendedAt,
          groupCount: u._count.groupMembers,
          createdAt: u.createdAt,
        })),
        totalCount: counts[0] as number | undefined,
        nextCursor,
      };
    }),

  // Legacy admin page must use the exact same transaction+WebAuthn guard as
  // /admin/users; it must never offer an alternate unauthenticated mutation.
  suspendUser: adminProcedure
    .input(z.object({ userId: z.string().min(1).max(128), approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }))
    .mutation(async ({ ctx, input }) => {
      const result = await changeRegisteredUserSuspension({
        db: ctx.db,
        ownerId: ctx.user.id,
        userId: input.userId,
        suspend: true,
        approvalToken: input.approvalToken,
        sessionHash: ownerSessionFingerprint(ctx.headers),
      });
      return { suspended: result.suspended, userId: result.userId };
    }),

  unsuspendUser: adminProcedure
    .input(z.object({ userId: z.string().min(1).max(128), approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }))
    .mutation(async ({ ctx, input }) => {
      const result = await changeRegisteredUserSuspension({
        db: ctx.db,
        ownerId: ctx.user.id,
        userId: input.userId,
        suspend: false,
        approvalToken: input.approvalToken,
        sessionHash: ownerSessionFingerprint(ctx.headers),
      });
      return { unsuspended: !result.suspended, userId: result.userId };
    }),

  deleteUser: adminProcedure
    .input(z.object({ userId: z.string().min(1).max(128), approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) {
        throw new AppError('BAD_REQUEST', 'cannotDeleteYourself');
      }

      const sessionHash = ownerSessionFingerprint(ctx.headers);
      await ctx.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', ctx.user.id);
        await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.userId);
        // Double-check the immutable owner and account under the row lock.
        await requireOwner(tx, ctx.user.id);
        const bootstrap = await tx.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true } });
        if (bootstrap?.userId === input.userId) throw new AppError('FORBIDDEN');
        const user = await tx.user.findUnique({
          where: { id: input.userId },
          select: { id: true, email: true, isPlaceholder: true },
        });
        if (!user || user.isPlaceholder) throw new AppError('FORBIDDEN');
        await consumeOwnerPasskeyActionProof(tx, {
          userId: ctx.user.id,
          action: 'USER_DELETE',
          targetId: input.userId,
          sessionHash,
          approvalToken: input.approvalToken,
        });
        // Convert to placeholder to preserve financial history, then strip auth data
        await tx.user.update({
          where: { id: input.userId },
          data: {
            isPlaceholder: true,
            name: 'Deleted user',
            placeholderName: 'Deleted user',
            email: `deleted-${input.userId}@placeholder.local`,
            image: null,
            venmoUsername: null,
            suspendedAt: new Date(),
          },
        });
        // Remove sessions and WebAuthn credentials: deleted accounts must not
        // authenticate with a previously enrolled passkey.
        await tx.session.deleteMany({ where: { userId: input.userId } });
        await tx.passkeyLoginTicket.deleteMany({ where: { userId: input.userId } });
        await tx.webAuthnChallenge.deleteMany({ where: { userId: input.userId } });
        await tx.passkeyCredential.deleteMany({ where: { userId: input.userId } });
        // Transfer ownership before removing memberships
        const ownedGroups = await tx.groupMember.findMany({
          where: { userId: input.userId, role: 'OWNER' },
          select: { groupId: true },
        });
        const keepMembershipGroupIds: string[] = [];
        for (const { groupId } of ownedGroups) {
          const nextOwner = await tx.groupMember.findFirst({
            where: {
              groupId,
              userId: { not: input.userId },
              user: { isPlaceholder: false, suspendedAt: null },
            },
            orderBy: { joinedAt: 'asc' },
          });
          if (nextOwner) {
            await tx.groupMember.update({
              where: { id: nextOwner.id },
              data: { role: 'OWNER' },
            });
          } else {
            keepMembershipGroupIds.push(groupId);
          }
        }
        // Remove memberships except where user is the sole active owner
        await tx.groupMember.deleteMany({
          where: {
            userId: input.userId,
            ...(keepMembershipGroupIds.length > 0 ? { groupId: { notIn: keepMembershipGroupIds } } : {}),
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId: ctx.user.id,
            action: 'USER_DELETED',
            targetId: input.userId,
            metadata: { email: user.email },
          },
        });
      });

      return { deleted: true, userId: input.userId };
    }),

  listGroups: adminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        search: z.string().max(200).optional(),
        sortBy: z.enum(['name', 'memberCount', 'expenseCount', 'createdAt']).default('createdAt'),
        sortDirection: z.enum(['asc', 'desc']).default('desc'),
        status: z.enum(['all', 'active', 'archived']).default('all'),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Build where clause
      const where: Prisma.GroupWhereInput = {};

      if (input.status === 'active') {
        where.archivedAt = null;
      } else if (input.status === 'archived') {
        where.archivedAt = { not: null };
      }

      if (input.search) {
        where.name = { contains: input.search, mode: 'insensitive' };
      }

      type GroupOrderBy = Prisma.GroupOrderByWithRelationInput;
      const dir = input.sortDirection;
      const idTiebreaker: GroupOrderBy = { id: dir };
      let orderBy: GroupOrderBy[];
      switch (input.sortBy) {
        case 'name':
          orderBy = [{ name: dir }, idTiebreaker];
          break;
        case 'memberCount':
          orderBy = [{ members: { _count: dir } }, idTiebreaker];
          break;
        case 'expenseCount':
          orderBy = [{ expenses: { _count: dir } }, idTiebreaker];
          break;
        case 'createdAt':
        default:
          orderBy = [{ createdAt: dir }, idTiebreaker];
          break;
      }

      const isFirstPage = !input.cursor;

      const [groups, ...countsArr] = await Promise.all([
        ctx.db.group.findMany({
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
          where,
          select: {
            id: true,
            name: true,
            currency: true,
            archivedAt: true,
            createdAt: true,
            _count: {
              select: {
                members: true,
                expenses: true,
                settlements: true,
              },
            },
            activityLogs: {
              select: { createdAt: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
          orderBy,
        }),
        ...(isFirstPage
          ? [
              ctx.db.group.count({ where }),
              ctx.db.expense.count({ where: { group: where } }),
              ctx.db.settlement.count({ where: { group: where } }),
            ]
          : []),
      ]);

      let nextCursor: string | undefined;
      if (groups.length > input.limit) {
        const next = groups.pop();
        nextCursor = next?.id;
      }

      const groupIds = groups.map((g) => g.id);
      const expenseSums =
        groupIds.length > 0
          ? await ctx.db.expense.groupBy({
              by: ['groupId', 'currency'],
              where: { groupId: { in: groupIds } },
              _sum: { amount: true, baseCurrencyAmount: true },
              _count: { id: true, baseCurrencyAmount: true },
            })
          : [];
      const totals = totalsInGroupCurrency(groups, expenseSums);

      const result = groups.map((g) => ({
        id: g.id,
        name: g.name,
        memberCount: g._count.members,
        expenseCount: g._count.expenses,
        currency: g.currency,
        totalAmount: totals.get(g.id) ?? null,
        lastActivity: g.activityLogs[0]?.createdAt ?? g.createdAt,
        isArchived: g.archivedAt !== null,
        createdAt: g.createdAt,
      }));

      return {
        groups: result,
        totalCount: countsArr[0] as number | undefined,
        totalExpenses: countsArr[1] as number | undefined,
        totalSettlements: countsArr[2] as number | undefined,
        nextCursor,
      };
    }),

  deleteGroup: adminProcedure.input(z.object({ groupId: z.string() })).mutation(async ({ ctx, input }) => {
    const group = await ctx.db.group.findUnique({
      where: { id: input.groupId },
      select: { id: true, name: true },
    });

    if (!group) {
      throw new AppError('NOT_FOUND', 'groupNotFound');
    }

    const imagePaths = await ctx.db.$transaction(async (tx) => {
      // Waits for balance changes, removals and transfers in flight, as the owner's delete does
      await lockGroupMembers(tx, input.groupId);
      return deleteGroupWithData(tx, input.groupId);
    });
    await removeReceiptFiles(imagePaths);

    await logAdminAction(ctx.db, ctx.user.id, 'GROUP_DELETED', input.groupId, { name: group.name });

    return { deleted: true, groupId: input.groupId };
  }),

  // ─── Registration Control ───────────────────────────────

  getRegistrationMode: adminProcedure.query(async ({ ctx }) => ({ mode: await readRegistrationMode(ctx.db) })),

  setRegistrationMode: adminProcedure
    .input(
      z.object({
        mode: z.enum(REGISTRATION_MODES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.systemSetting.upsert({
        where: { key: 'registrationMode' },
        update: { value: input.mode },
        create: { key: 'registrationMode', value: input.mode },
      });

      await logAdminAction(ctx.db, ctx.user.id, 'REGISTRATION_MODE_CHANGED', null, { mode: input.mode });

      return { mode: input.mode };
    }),

  createSystemInvite: adminProcedure
    .input(
      z.strictObject({
        label: z.string().trim().min(1).max(100).optional(),
        // Existing clients may still pass 7; other durations and invitations
        // without an expiry are forbidden for BillOK (Issue #1 6.2).
        expiresInDays: z.literal(7).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const expiresAt = new Date(Date.now() + SYSTEM_INVITE_TTL_MS);
      // The invite and its audit record are committed together. Never log the
      // bearer code itself: it is returned only to the authenticated admin for
      // manual delivery and can be viewed later in that admin's invite list.
      const invite = await ctx.db.$transaction(async (tx) => {
        const created = await tx.systemInvite.create({
          data: {
            ...(input.label !== undefined ? { label: input.label } : {}),
            expiresAt,
          },
        });
        await tx.adminAuditLog.create({
          data: {
            adminId: ctx.user.id,
            action: 'INVITE_CREATED',
            targetId: created.id,
            metadata: { label: created.label, expiresAt: expiresAt.toISOString() },
          },
        });
        return created;
      });

      return {
        id: invite.id,
        code: invite.code,
        label: invite.label,
        expiresAt: invite.expiresAt,
      };
    }),

  listSystemInvites: adminProcedure.query(async ({ ctx }) => {
    const invites = await ctx.db.systemInvite.findMany({
      take: 200,
      include: {
        usedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    return invites.map((inv) => {
      const available =
        !inv.revokedAt &&
        !inv.usedAt &&
        !!inv.expiresAt &&
        inv.expiresAt > now &&
        inv.createdAt > activeSystemInviteWindow(now).createdAt.gt;
      const isReserved = available && !!inv.reservedById && !!inv.reservedUntil && inv.reservedUntil > now;
      return {
        id: inv.id,
        code: inv.code,
        label: inv.label,
        usedBy: inv.usedBy ? { name: inv.usedBy.name, email: inv.usedBy.email } : null,
        usedAt: inv.usedAt,
        expiresAt: inv.expiresAt,
        revokedAt: inv.revokedAt,
        isReserved,
        isActive: available && !isReserved,
        // Revocation must remain available while registration is still
        // awaiting email confirmation: reservation is NOT consumption.
        canRevoke: available,
        createdAt: inv.createdAt,
      };
    });
  }),

  revokeSystemInvite: adminProcedure
    .input(z.strictObject({ inviteId: z.string().min(1).max(128) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const invite = await tx.systemInvite.findUnique({
          where: { id: input.inviteId },
          select: { id: true, usedAt: true, usedById: true, revokedAt: true, createdAt: true, expiresAt: true },
        });
        if (!invite) throw new AppError('NOT_FOUND', 'inviteNotFound');
        if (invite.revokedAt) throw new AppError('BAD_REQUEST', 'inviteAlreadyRevoked');
        if (invite.usedAt || invite.usedById) throw new AppError('BAD_REQUEST', 'inviteAlreadyUsed');
        const now = new Date();
        if (
          !invite.expiresAt ||
          invite.expiresAt <= now ||
          invite.createdAt <= activeSystemInviteWindow(now).createdAt.gt
        ) {
          throw new AppError('BAD_REQUEST', 'inviteInvalid');
        }
        // Conditional write closes the race with concurrent verification,
        // cancellation or a second admin revocation. The reservation, if any,
        // remains invalidated by revokedAt; it cannot be redeemed afterward.
        const result = await tx.systemInvite.updateMany({
          where: {
            id: invite.id,
            revokedAt: null,
            usedAt: null,
            usedById: null,
            ...activeSystemInviteWindow(now),
          },
          data: { revokedAt: now },
        });
        if (result.count !== 1) throw new AppError('CONFLICT', 'inviteInvalid');
        await tx.adminAuditLog.create({
          data: {
            adminId: ctx.user.id,
            action: 'INVITE_REVOKED',
            targetId: invite.id,
            metadata: { revokedAt: now.toISOString() },
          },
        });
        return { revoked: true };
      });
    }),

  // ─── Global Activity Feed ────────────────────────────────

  getGlobalActivity: adminProcedure
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.activityLog.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, name: true, email: true } },
          group: { select: { id: true, name: true } },
        },
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return {
        items: items.map((item) => ({
          id: item.id,
          type: item.type,
          entityId: item.entityId,
          metadata: item.metadata as Record<string, unknown> | null,
          userName: item.user?.name ?? item.user?.email ?? 'Deleted user',
          userEmail: item.user?.email ?? null,
          groupName: item.group.name,
          groupId: item.group.id,
          createdAt: item.createdAt,
        })),
        nextCursor,
      };
    }),

  // ─── Announcement Banner ─────────────────────────────────

  getAnnouncement: publicProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: 'announcement' },
    });
    return { message: setting?.value ?? null };
  }),

  setAnnouncement: adminProcedure
    .input(
      z.object({
        message: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.message || input.message.trim() === '') {
        // Clear announcement
        await ctx.db.systemSetting.deleteMany({
          where: { key: 'announcement' },
        });
      } else {
        await ctx.db.systemSetting.upsert({
          where: { key: 'announcement' },
          update: { value: input.message.trim() },
          create: { key: 'announcement', value: input.message.trim() },
        });
      }

      await logAdminAction(ctx.db, ctx.user.id, 'ANNOUNCEMENT_SET', null, { message: input.message ?? null });

      return { success: true };
    }),

  // Legacy ShareTab API preserved for compatibility, but BillOK uses RUB and SBP only.
  // Ignore any persisted Venmo toggle, including on old USD receipts.
  getVenmoEnabled: publicProcedure.query(() => ({ enabled: false })),

  setVenmoEnabled: adminProcedure.input(z.object({ enabled: z.boolean() })).mutation(({ input }) => {
    if (input.enabled) throw new AppError('FORBIDDEN');
    // Do not rewrite persisted legacy records just to hide a retired feature.
    return { success: true };
  }),

  // ─── Email Test ──────────────────────────────────────────

  sendTestEmail: adminProcedure.mutation(async ({ ctx }) => {
    const host = process.env.EMAIL_SERVER_HOST;
    if (!host) {
      throw new AppError('PRECONDITION_FAILED', 'emailNotConfigured');
    }

    const transport = nodemailer.createTransport({
      host,
      port: parseInt(process.env.EMAIL_SERVER_PORT ?? '587'),
      secure: parseInt(process.env.EMAIL_SERVER_PORT ?? '587') === 465,
      auth: {
        user: process.env.EMAIL_SERVER_USER,
        pass: process.env.EMAIL_SERVER_PASSWORD,
      },
    });

    const from = process.env.EMAIL_FROM ?? 'BillOK <noreply@billok.ru>';
    const to = ctx.user.email!;

    try {
      await transport.sendMail({
        from,
        to,
        subject: 'Проверка электронной почты BillOK',
        text: `Это тестовое письмо из панели администратора BillOK.\n\nОтправлено: ${new Date().toISOString()}\nАдминистратор: ${ctx.user.email}`,
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
            <h2 style="color: #10b981;">Проверка электронной почты BillOK</h2>
            <p>Это тестовое письмо из панели администратора BillOK.</p>
            <p style="color: #666; font-size: 14px;">
              Отправлено: ${new Date().toISOString()}<br/>
              Администратор: ${ctx.user.email}
            </p>
          </div>
        `,
      });

      await logAdminAction(ctx.db, ctx.user.id, 'TEST_EMAIL_SENT', null, {
        to,
      });

      return { success: true, sentTo: to };
    } catch (error) {
      throw new AppError('INTERNAL_SERVER_ERROR', 'testEmailFailed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }),

  // ─── Storage ────────────────────────────────────────────

  getStorageStats: adminProcedure.query(async ({ ctx }) => {
    // Receipt count from DB
    const receiptCount = await ctx.db.receipt.count();

    // Get all receipt image paths from DB
    const receipts = await ctx.db.receipt.findMany({
      select: { imagePath: true },
    });
    const dbPaths = new Set(receipts.map((r) => r.imagePath));

    // Scan uploads directory
    const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? './uploads');

    let totalDiskUsage = 0;
    let orphanCount = 0;
    const orphanPaths: string[] = [];
    let diskFiles = 0;

    if (fs.existsSync(uploadDir)) {
      const scanDir = async (dir: string) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanDir(fullPath);
          } else {
            diskFiles++;
            const stat = await fsp.stat(fullPath);
            totalDiskUsage += stat.size;

            const relativePath = path.relative(uploadDir, fullPath).replace(/\\/g, '/');
            const isReferenced =
              dbPaths.has(relativePath) ||
              dbPaths.has(`uploads/${relativePath}`) ||
              dbPaths.has(`/uploads/${relativePath}`) ||
              dbPaths.has(fullPath);

            if (!isReferenced) {
              orphanCount++;
              orphanPaths.push(relativePath);
            }
          }
        }
      };
      await scanDir(uploadDir);
    }

    const unused = await countUnusedReceipts(ctx.db);

    return {
      receiptCount,
      diskFiles,
      totalDiskUsage,
      totalDiskUsageFormatted: formatBytes(totalDiskUsage),
      orphanCount,
      orphanPaths,
      unusedReceiptCount: unused.count,
      unusedReceiptBytes: unused.bytes,
      unusedReceiptBytesFormatted: formatBytes(unused.bytes),
    };
  }),

  cleanupOrphans: adminProcedure.mutation(async ({ ctx }) => {
    // Get all receipt image paths from DB
    const receipts = await ctx.db.receipt.findMany({
      select: { imagePath: true },
    });
    const dbPaths = new Set(receipts.map((r) => r.imagePath));

    const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? './uploads');

    let deletedCount = 0;
    let freedBytes = 0;

    if (fs.existsSync(uploadDir)) {
      const scanAndDelete = async (dir: string) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanAndDelete(fullPath);
            try {
              const remaining = await fsp.readdir(fullPath);
              if (remaining.length === 0) {
                await fsp.rm(fullPath);
              }
            } catch {
              // ignore
            }
          } else {
            const relativePath = path.relative(uploadDir, fullPath).replace(/\\/g, '/');
            const isReferenced =
              dbPaths.has(relativePath) ||
              dbPaths.has(`uploads/${relativePath}`) ||
              dbPaths.has(`/uploads/${relativePath}`) ||
              dbPaths.has(fullPath);

            if (!isReferenced) {
              const stat = await fsp.stat(fullPath);
              freedBytes += stat.size;
              await fsp.unlink(fullPath);
              deletedCount++;
            }
          }
        }
      };
      await scanAndDelete(uploadDir);
    }

    if (deletedCount > 0) {
      await logAdminAction(ctx.db, ctx.user.id, 'ORPHANS_CLEANED', null, {
        deletedCount,
        freedBytes,
      });
    }

    return {
      deletedCount,
      freedBytes,
      freedBytesFormatted: formatBytes(freedBytes),
    };
  }),

  // Receipts no group, expense or split uses, a day or more old (#312), with their files
  cleanupUnusedReceipts: adminProcedure.mutation(async ({ ctx }) => {
    const deletedCount = await deleteUnusedReceipts(ctx.db, 500);
    if (deletedCount > 0) {
      await logAdminAction(ctx.db, ctx.user.id, 'UNUSED_RECEIPTS_CLEANED', null, { deletedCount });
    }
    return { deletedCount };
  }),

  // ─── Guest Split Cleanup ──────────────────────────────────

  getExpiredSplitCount: adminProcedure.query(async ({ ctx }) => {
    const expiredCount = await ctx.db.guestSplit.count({
      where: { status: GuestSplitStatus.CLAIMING, expiresAt: { lt: new Date() } },
    });
    const totalCount = await ctx.db.guestSplit.count({ where: { status: GuestSplitStatus.CLAIMING } });
    return { expiredCount, totalCount };
  }),

  cleanupExpiredSplits: adminProcedure.mutation(async ({ ctx }) => {
    // With the receipts only they used (#265), a batch at a time so a large backlog
    // doesn't make one long transaction
    const batchSize = 500;
    let deletedCount = 0;
    for (;;) {
      const count = await deleteExpiredSplits(ctx.db, batchSize);
      deletedCount += count;
      if (count === 0) break;
    }

    if (deletedCount > 0) {
      await logAdminAction(ctx.db, ctx.user.id, 'EXPIRED_SPLITS_CLEANED', null, { deletedCount });
    }

    return { deletedCount };
  }),

  // ─── Server Logs ─────────────────────────────────────────

  getLogs: adminProcedure
    .input(
      z.object({
        minLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
        search: z.string().max(200).optional(),
        limit: z.number().min(1).max(500).default(200),
        afterId: z.number().optional(),
      }),
    )
    .query(({ input }) => {
      return getRecentLogs({
        ...(input.minLevel !== undefined ? { minLevel: input.minLevel } : {}),
        ...(input.search ? { search: input.search } : {}),
        limit: input.limit,
        ...(input.afterId !== undefined ? { afterId: input.afterId } : {}),
      });
    }),
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
