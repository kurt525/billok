import { z } from 'zod';
import { requireOwner } from '@/server/lib/owner-access';
import { readRegistrationEmailConfig } from '@/server/lib/auth-config';
import { sendBillokTransactionalEmail } from '@/server/lib/transactional-email';
import { isAllowedRegistrationEmailDomain } from '@/server/lib/registration-email-domain';
import { AppError } from '@/server/lib/app-error';
import { createTRPCRouter, publicProcedure, protectedProcedure } from '../init';
import { type AdminAction, type PrismaClient, GuestSplitStatus, Prisma } from '@/generated/prisma/client';
import { getRecentLogs } from '@/server/lib/logger';
import { deleteGroupWithData } from '@/server/lib/group-delete';
import { lockGroupMembers } from '@/server/lib/group-balances';
import { countUnusedReceipts, deleteExpiredSplits, deleteUnusedReceipts } from '@/server/lib/receipt-cleanup';
import { getBuildInfo, getDeploymentDate } from '@/server/lib/build-info';
import { REGISTRATION_MODES, readRegistrationMode } from '@/server/lib/registration-mode';
import { activeSystemInviteWindow, SYSTEM_INVITE_TTL_MS } from '@/server/lib/system-invite-lifetime';
import { totalsInGroupCurrency } from '@/server/lib/group-expense-totals';
import { listOwnerRegisteredUsers, changeRegisteredUserSuspension } from '@/server/lib/owner-user-admin';
import { decodeOwnerUserCursor, encodeOwnerUserCursor, ownerUserCursorScope } from '@/server/lib/owner-user-cursor';
import { ownerSessionFingerprint, consumeOwnerPasskeyActionProof } from '@/server/lib/owner-passkey-action-approval';
import { normalizeSecurityActorUuid } from '@/lib/security-actor-uuid';
import { systemInviteCreateApprovalTarget } from '@/lib/system-invite-approval-target';
import { registrationModeApprovalTarget, announcementApprovalTarget } from '@/lib/admin-setting-approval-target';

const serverStartTime = new Date();
const buildInfo = getBuildInfo();
const { version: cachedVersion, commitSha: cachedCommitSha } = buildInfo;

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
        cursor: z.string().max(512).optional(),
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

  // Dedicated security journal: even the owner may READ but cannot change
  // or delete events through any exposed API. Ordinary users see nothing.
  getSecurityEvents: adminProcedure
    .input(
      z.strictObject({
        cursor: z.string().max(512).optional(),
        // tRPC infinite queries send this transport field. Only forward paging is supported.
        direction: z.literal('forward').optional(),
        limit: z.number().int().min(1).max(50).default(20),
        actorId: z
          .string()
          .max(128)
          .trim()
          .refine((value) => normalizeSecurityActorUuid(value) !== null)
          .transform((value) => normalizeSecurityActorUuid(value)!)
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Filtered cursors are bound to owner, UUID and page size; keep the
      // historical raw ID cursor contract for the unfiltered endpoint.
      const scope = ownerUserCursorScope('security-events', { actorId: input.actorId, limit: input.limit });
      const cursor =
        input.cursor && input.actorId ? decodeOwnerUserCursor(input.cursor, ctx.user.id, scope) : input.cursor;
      if (!input.actorId && cursor && (cursor.startsWith('u1.') || cursor.length > 128)) {
        throw new AppError('BAD_REQUEST');
      }
      const entries = await ctx.db.securityEvent.findMany({
        take: input.limit + 1,
        ...(input.actorId ? { where: { actorId: { equals: input.actorId, mode: 'insensitive' as const } } } : {}),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          actorId: true,
          targetFingerprint: true,
          action: true,
          outcome: true,
          createdAt: true,
        },
      });
      const more = entries.length > input.limit;
      const page = more ? entries.slice(0, input.limit) : entries;
      const ids = [
        ...new Set(
          page.flatMap((entry) =>
            entry.actorId ? [entry.actorId, normalizeSecurityActorUuid(entry.actorId) ?? entry.actorId] : [],
          ),
        ),
      ];
      // Only resolve already-recorded account IDs in this bounded page.
      // No matching by email, name, or target fingerprint.
      const accounts = ids.length
        ? await ctx.db.user.findMany({
            where: { id: { in: ids }, isPlaceholder: false },
            select: { id: true, name: true, email: true },
          })
        : [];
      const byId = new Map(accounts.map((account) => [account.id, account]));
      const last = more ? page.at(-1)?.id : undefined;
      return {
        items: page.map((entry) => {
          const account = entry.actorId
            ? (byId.get(entry.actorId) ?? byId.get(normalizeSecurityActorUuid(entry.actorId) ?? entry.actorId))
            : undefined;
          return {
            ...entry,
            actor: account
              ? {
                  name: account.name,
                  email: account.email,
                  isOwner: account.id === ctx.user.id,
                }
              : null,
          };
        }),
        nextCursor: last && input.actorId ? encodeOwnerUserCursor(last, ctx.user.id, scope) : last,
      };
    }),

  getAuditLog: adminProcedure
    .input(
      z.object({
        cursor: z.string().max(128).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        action: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.db.adminAuditLog.findMany({
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
        ...(input.action ? { where: { action: input.action as AdminAction } } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          admin: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      // Cursor is the first unseen row (inclusive), preserving the existing API.
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

  getSystemHealth: adminProcedure.query(() => ({
    version: cachedVersion,
    commitSha: cachedCommitSha,
    release: buildInfo.release,
    deployedAt: getDeploymentDate(buildInfo),
    serverStartTime: serverStartTime.toISOString(),
    uptime: Math.floor((Date.now() - serverStartTime.getTime()) / 1000),
  })),

  listUsers: adminProcedure
    .input(
      z.object({
        cursor: z.string().max(512).optional(),
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

      const cursorScope = ownerUserCursorScope('listUsers', {
        search: input.search ?? '',
        sortBy: input.sortBy,
        sortDirection: input.sortDirection,
        status: input.status,
        limit: input.limit,
      });
      const cursorId = input.cursor ? decodeOwnerUserCursor(input.cursor, ctx.user.id, cursorScope) : undefined;
      const isFirstPage = !input.cursor;
      const [users, ...counts] = await Promise.all([
        ctx.db.user.findMany({
          take: input.limit + 1,
          ...(cursorId ? { cursor: { id: cursorId } } : {}),
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
        nextCursor = next?.id ? encodeOwnerUserCursor(next.id, ctx.user.id, cursorScope) : undefined;
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
              _sum: { amount: true },
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

    await ctx.db.$transaction(async (tx) => {
      // Waits for balance changes, removals and transfers in flight, as the owner's delete does
      await lockGroupMembers(tx, input.groupId);
      return deleteGroupWithData(tx, input.groupId);
    });

    await logAdminAction(ctx.db, ctx.user.id, 'GROUP_DELETED', input.groupId, { name: group.name });

    return { deleted: true, groupId: input.groupId };
  }),

  // ─── Registration Control ───────────────────────────────

  getRegistrationMode: adminProcedure.query(async ({ ctx }) => ({ mode: await readRegistrationMode(ctx.db) })),

  setRegistrationMode: adminProcedure
    .input(
      z.strictObject({
        mode: z.enum(REGISTRATION_MODES),
        approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sessionHash = ownerSessionFingerprint(ctx.headers);
      return ctx.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', ctx.user.id);
        await requireOwner(tx, ctx.user.id);
        await consumeOwnerPasskeyActionProof(tx, {
          userId: ctx.user.id,
          action: 'REGISTRATION_MODE_UPDATE',
          targetId: registrationModeApprovalTarget(input.mode),
          sessionHash,
          approvalToken: input.approvalToken,
        });
        await tx.systemSetting.upsert({
          where: { key: 'registrationMode' },
          update: { value: input.mode },
          create: { key: 'registrationMode', value: input.mode },
        });
        await tx.adminAuditLog.create({
          data: { adminId: ctx.user.id, action: 'REGISTRATION_MODE_CHANGED', metadata: { mode: input.mode } },
        });
        return { mode: input.mode };
      });
    }),

  createSystemInvite: adminProcedure
    .input(
      z.strictObject({
        label: z.string().trim().min(1).max(100).optional(),
        // Existing clients may still pass 7; other durations and invitations
        // without an expiry are forbidden for BillOK (Issue #1 6.2).
        expiresInDays: z.literal(7).optional(),
        approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sessionHash = ownerSessionFingerprint(ctx.headers);
      const createTarget = systemInviteCreateApprovalTarget(input.label);
      const expiresAt = new Date(Date.now() + SYSTEM_INVITE_TTL_MS);
      // The invite and its audit record are committed together. Never log the
      // bearer code itself: it is returned only to the authenticated admin for
      // manual delivery and can be viewed later in that admin's invite list.
      const invite = await ctx.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', ctx.user.id);
        await requireOwner(tx, ctx.user.id);
        await consumeOwnerPasskeyActionProof(tx, {
          userId: ctx.user.id,
          action: 'SYSTEM_INVITE_CREATE',
          targetId: createTarget,
          sessionHash,
          approvalToken: input.approvalToken,
        });
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
    .input(
      z.strictObject({
        inviteId: z.string().min(1).max(128),
        approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sessionHash = ownerSessionFingerprint(ctx.headers);
      return ctx.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', ctx.user.id);
        await tx.$queryRawUnsafe('SELECT id FROM "SystemInvite" WHERE id = $1 FOR UPDATE', input.inviteId);
        await requireOwner(tx, ctx.user.id);
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
        await consumeOwnerPasskeyActionProof(tx, {
          userId: ctx.user.id,
          action: 'SYSTEM_INVITE_REVOKE',
          targetId: input.inviteId,
          sessionHash,
          approvalToken: input.approvalToken,
        });
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

  // ─── Announcement Banner ─────────────────────────────────

  getAnnouncement: publicProcedure.query(async ({ ctx }) => {
    const setting = await ctx.db.systemSetting.findUnique({
      where: { key: 'announcement' },
    });
    return { message: setting?.value ?? null };
  }),

  setAnnouncement: adminProcedure
    .input(
      z.strictObject({
        message: z.string().max(500).optional(),
        approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const message = input.message?.trim() ?? '';
      const targetId = await announcementApprovalTarget(message);
      const sessionHash = ownerSessionFingerprint(ctx.headers);
      return ctx.db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', ctx.user.id);
        await requireOwner(tx, ctx.user.id);
        await consumeOwnerPasskeyActionProof(tx, {
          userId: ctx.user.id,
          action: 'OWNER_SETTING_UPDATE',
          targetId,
          sessionHash,
          approvalToken: input.approvalToken,
        });
        if (!message) {
          await tx.systemSetting.deleteMany({ where: { key: 'announcement' } });
        } else {
          await tx.systemSetting.upsert({
            where: { key: 'announcement' },
            update: { value: message },
            create: { key: 'announcement', value: message },
          });
        }
        await tx.adminAuditLog.create({
          data: { adminId: ctx.user.id, action: 'ANNOUNCEMENT_SET', metadata: { message: message || null } },
        });
        return { success: true };
      });
    }),

  // ─── Email Test ──────────────────────────────────────────

  sendTestEmail: adminProcedure.mutation(async ({ ctx }) => {
    // 7.4: use the SAME strict REG.RU transport as confirmation and recovery.
    // This is not a sign-in link and cannot register an Auth.js provider.
    let mail: ReturnType<typeof readRegistrationEmailConfig>;
    try {
      mail = readRegistrationEmailConfig(process.env);
    } catch {
      throw new AppError('PRECONDITION_FAILED', 'emailNotConfigured');
    }
    const to = ctx.user.email;
    if (!to || !isAllowedRegistrationEmailDomain(to)) throw new AppError('PRECONDITION_FAILED', 'emailNotConfigured');

    const sentAt = new Date().toISOString();
    try {
      await sendBillokTransactionalEmail({
        from: mail.from,
        to,
        server: mail.server,
        message: {
          subject: 'Проверка электронной почты BillOK',
          text: [
            'Это контрольное письмо из панели владельца BillOK.',
            'Время UTC: ' + sentAt,
            'Письмо не предоставляет доступ к учётной записи.',
          ].join('\n'),
          html: [
            '<div lang="ru" style="font-family:Arial,sans-serif;max-width:480px;margin:auto">',
            '<h2>Проверка электронной почты BillOK</h2>',
            '<p>Это контрольное письмо из панели владельца BillOK.</p>',
            '<p>Время UTC: ' + sentAt + '</p>',
            '<p>Письмо не предоставляет доступ к учётной записи.</p>',
            '</div>',
          ].join(''),
        },
        errorMessage: 'Не удалось отправить контрольное письмо BillOK',
      });

      await logAdminAction(ctx.db, ctx.user.id, 'TEST_EMAIL_SENT', null, { to });
      return { success: true, sentTo: to };
    } catch {
      // Do not expose SMTP server details or secret-related errors to clients.
      throw new AppError('INTERNAL_SERVER_ERROR', 'testEmailFailed');
    }
  }),

  // ─── Storage ────────────────────────────────────────────

  // One grouped query gives a consistent snapshot of all manual split receipts.
  // Linked Receipt rows are not additional user-facing checks.
  getStorageStats: adminProcedure.query(async ({ ctx }) => {
    const [statuses, unused] = await Promise.all([
      ctx.db.guestSplit.groupBy({ by: ['status'], _count: { _all: true } }),
      countUnusedReceipts(ctx.db),
    ]);
    const claimingCount = statuses.find((row) => row.status === GuestSplitStatus.CLAIMING)?._count._all ?? 0;
    const finalizedCount = statuses.find((row) => row.status === GuestSplitStatus.FINALIZED)?._count._all ?? 0;
    return {
      receiptCount: claimingCount + finalizedCount,
      claimingCount,
      finalizedCount,
      unusedReceiptCount: unused.count,
    };
  }),

  // Receipts no group, expense or split uses, a day or more old (#312)
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
