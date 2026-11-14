import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import { AppError } from './app-error';
import { requireOwner } from './owner-access';
import { revokeAccountAuthenticationStateInTransaction } from './revoke-account-auth';
import { consumeOwnerPasskeyActionProof } from './owner-passkey-action-approval';

export const OWNER_USERS_PAGE_LIMIT = 20;
export type OwnerUserStatus = 'all' | 'active' | 'suspended' | 'pending';
export type OwnerUserSort = 'name' | 'email' | 'createdAt';
export type OwnerUserSortDirection = 'asc' | 'desc';

// Shared with every other administrative operation.
export async function requireRegisteredOwner(db: PrismaClient, userId: string): Promise<void> {
  await requireOwner(db, userId);
}

export async function listOwnerRegisteredUsers(
  db: PrismaClient,
  ownerId: string,
  input: {
    cursor?: string | undefined;
    limit: number;
    search?: string | undefined;
    status: OwnerUserStatus;
    sortBy: OwnerUserSort;
    sortDirection: OwnerUserSortDirection;
  },
) {
  // Only registered accounts; guest/placeholder rows are NOT user accounts.
  const where: Prisma.UserWhereInput = { isPlaceholder: false };
  if (input.status === 'active') {
    where.suspendedAt = null;
    where.emailVerified = { not: null };
  } else if (input.status === 'suspended') {
    where.suspendedAt = { not: null };
  } else if (input.status === 'pending') {
    where.suspendedAt = null;
    where.emailVerified = null;
  }
  const search = input.search?.trim();
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }
  const orderBy: Prisma.UserOrderByWithRelationInput[] =
    input.sortBy === 'name'
      ? [{ name: { sort: input.sortDirection, nulls: 'last' } }, { id: input.sortDirection }]
      : [{ [input.sortBy]: input.sortDirection }, { id: input.sortDirection }];
  const [users, totalCount] = await Promise.all([
    db.user.findMany({
      where,
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      orderBy,
      select: { id: true, name: true, email: true, createdAt: true, suspendedAt: true, emailVerified: true },
    }),
    db.user.count({ where }),
  ]);
  const more = users.length > input.limit;
  const page = more ? users.slice(0, input.limit) : users;
  return {
    users: page.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      status: user.suspendedAt
        ? ('suspended' as const)
        : !user.emailVerified
          ? ('pending' as const)
          : ('active' as const),
      isOwner: user.id === ownerId,
    })),
    totalCount,
    nextCursor: more ? page.at(-1)?.id : undefined,
  };
}

export async function changeRegisteredUserSuspension(input: {
  db: PrismaClient;
  ownerId: string;
  userId: string;
  suspend: boolean;
  sessionHash: string;
  approvalToken: string;
  now?: Date;
}): Promise<{ suspended: boolean; userId: string }> {
  if (!input.ownerId || !input.userId || input.userId === input.ownerId || !input.approvalToken || !input.sessionHash)
    throw new AppError('FORBIDDEN');
  const now = input.now ?? new Date();
  return input.db.$transaction(async (tx) => {
    // Serialize owner privilege/proof checks and target mutations. All paths
    // lock owner first, target second, to avoid opposite-order deadlocks.
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.ownerId);
    await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', input.userId);
    const [bootstrap, actor, target] = await Promise.all([
      tx.ownerBootstrap.findUnique({ where: { id: 1 }, select: { userId: true, completedAt: true } }),
      tx.user.findUnique({
        where: { id: input.ownerId },
        select: { emailVerified: true, suspendedAt: true, isPlaceholder: true },
      }),
      tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, suspendedAt: true, isPlaceholder: true },
      }),
    ]);
    if (
      !bootstrap?.completedAt ||
      bootstrap.userId !== input.ownerId ||
      !actor?.emailVerified ||
      actor.suspendedAt ||
      actor.isPlaceholder ||
      bootstrap.userId === input.userId ||
      !target ||
      target.isPlaceholder ||
      Boolean(target.suspendedAt) === input.suspend
    )
      throw new AppError('FORBIDDEN');
    // A signed proof is consumed in the SAME PostgreSQL transaction as the
    // actual status change. Any error rolls both the status and proof back.
    await consumeOwnerPasskeyActionProof(tx, {
      userId: input.ownerId,
      action: input.suspend ? 'USER_SUSPEND' : 'USER_UNSUSPEND',
      targetId: input.userId,
      sessionHash: input.sessionHash,
      approvalToken: input.approvalToken,
      now,
    });
    const result = await tx.user.updateMany({
      where: {
        id: input.userId,
        isPlaceholder: false,
        suspendedAt: input.suspend ? null : { not: null },
      },
      data: { suspendedAt: input.suspend ? now : null },
    });
    if (result.count !== 1) throw new AppError('FORBIDDEN');
    if (input.suspend) {
      // Existing Passkeys remain enrolled, but old JWTs and outstanding
      // login tickets are invalidated immediately after suspension.
      await revokeAccountAuthenticationStateInTransaction(tx, input.userId);
    }
    await tx.adminAuditLog.create({
      data: {
        adminId: input.ownerId,
        action: input.suspend ? 'USER_SUSPENDED' : 'USER_UNSUSPENDED',
        targetId: input.userId,
        metadata: { email: target.email, source: 'owner-admin-users' },
      },
    });
    return { suspended: input.suspend, userId: input.userId };
  });
}
