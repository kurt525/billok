import { cookies } from 'next/headers';
import type { Session } from 'next-auth';
import { auth } from '@/server/auth';
import { recordOwnerSecurityEvent } from '@/server/lib/security-event-audit';
import { readBoundedJson } from '@/server/lib/read-bounded-json';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { logAdminAction } from '@/server/trpc/routers/admin';
import { signPayload } from '@/server/lib/signed-cookie';
import { currentImpersonationSessionBinding, verifiedImpersonationSession } from '@/server/lib/impersonation-session';
import { ownerSessionFingerprint, consumeOwnerPasskeyActionProof } from '@/server/lib/owner-passkey-action-approval';

const COOKIE_NAME = 'sharetab-impersonate';

/**
 * POST /api/admin/impersonate
 * Body: { userId: string, approvalToken: string }
 * Sets impersonation cookie so tRPC context switches effective user.
 */
async function performAuditedOwnerPost(req: Request, session: Session | null) {
  if (!session?.user?.id) return Response.json({ error: 'Доступ запрещён' }, { status: 403 });
  try {
    await requireOwner(db, session.user.id);
  } catch {
    return Response.json({ error: 'Доступ запрещён' }, { status: 403 });
  }

  const cookieStore = await cookies();
  // Never start another impersonation while the mode cookie is present.
  if (cookieStore.get(COOKIE_NAME)) return Response.json({ error: 'Доступ запрещён' }, { status: 403 });
  const binding = await currentImpersonationSessionBinding(req, session.user.id);
  if (!binding) return Response.json({ error: 'Доступ запрещён' }, { status: 403 });

  const body = await readBoundedJson(req, 1024);
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 2 ||
    typeof (body as { userId?: unknown }).userId !== 'string' ||
    typeof (body as { approvalToken?: unknown }).approvalToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test((body as { approvalToken: string }).approvalToken)
  ) {
    return Response.json({ error: 'Не указан пользователь' }, { status: 400 });
  }
  const targetUserId = (body as { userId: string }).userId;
  if (!targetUserId || targetUserId.length > 128) {
    return Response.json({ error: 'Не указан пользователь' }, { status: 400 });
  }

  if (targetUserId === session.user.id) {
    return Response.json({ error: 'Нельзя войти от собственного имени' }, { status: 400 });
  }

  // One signed grant is valid ONLY for this target and authenticated session.
  // Owner lock, target lock, proof consumption and audit are one transaction.
  // The impersonation cookie is never set if any check or write fails.
  let targetUser: { id: string; name: string | null; email: string } | null;
  try {
    const sessionHash = ownerSessionFingerprint(req.headers);
    targetUser = await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', session.user.id);
      await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', targetUserId);
      await requireOwner(tx, session.user.id);
      const selected = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, name: true, email: true, emailVerified: true, suspendedAt: true, isPlaceholder: true },
      });
      // The request target is an OBJECT, never an actor. A suspended,
      // pending or placeholder user is not a valid impersonation identity.
      // Validate after locking the target row and BEFORE spending the grant.
      if (!selected || !selected.emailVerified || selected.suspendedAt || selected.isPlaceholder) return null;
      await consumeOwnerPasskeyActionProof(tx, {
        userId: session.user.id,
        action: 'IMPERSONATE',
        targetId: targetUserId,
        sessionHash,
        approvalToken: (body as { approvalToken: string }).approvalToken,
      });
      await tx.adminAuditLog.create({
        data: {
          adminId: session.user.id,
          action: 'IMPERSONATION_STARTED',
          targetId: targetUserId,
          metadata: { targetEmail: selected.email, targetName: selected.name },
        },
      });
      return selected;
    });
  } catch {
    return Response.json({ error: 'Доступ запрещён' }, { status: 403 });
  }
  if (!targetUser) return Response.json({ error: 'Пользователь не найден' }, { status: 404 });

  const impersonationData = JSON.stringify({
    adminId: session.user.id,
    adminEmail: session.user.email,
    targetId: targetUser.id,
    targetName: targetUser.name,
    targetEmail: targetUser.email,
    startedAt: new Date().toISOString(),
    sessionBinding: binding,
  });

  cookieStore.set(COOKIE_NAME, signPayload(impersonationData), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60, // 1 hour max
  });

  return Response.json({
    success: true,
    impersonating: {
      id: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
    },
  });
}

/**
 * DELETE /api/admin/impersonate
 * Clears the impersonation cookie.
 */
export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: 'Доступ запрещён' }, { status: 403 });
  try {
    await requireOwner(db, session.user.id);
  } catch {
    return Response.json({ error: 'Доступ запрещён' }, { status: 403 });
  }

  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;

  const binding = await currentImpersonationSessionBinding(req, session.user.id);
  if (raw && binding) {
    const data = verifiedImpersonationSession(raw, session.user.id, binding);
    if (data) {
      await logAdminAction(db, session.user.id, 'IMPERSONATION_ENDED', data.targetId, {
        targetEmail: data.targetEmail,
        targetName: data.targetName,
      });
    }
  }

  // Clearing the cookie never changes or issues an Auth.js session.
  cookieStore.delete(COOKIE_NAME);
  return Response.json({ success: true });
}

export async function POST(request: Request) {
  const session = await auth().catch(() => null);
  let response: Response;
  try {
    response = await performAuditedOwnerPost(request, session);
  } catch {
    response = Response.json({ error: 'Доступ запрещён' }, { status: 403 });
  }
  // Successful audit is a separate durable security event; the existing
  // transaction-bound AdminAuditLog remains authoritative for mutations.
  // Denied requests are recorded OUTSIDE rolled-back transactions.
  await recordOwnerSecurityEvent({
    db,
    action: 'IMPERSONATION_STARTED',
    outcome: response.status >= 400 ? 'DENIED' : 'ALLOWED',
    actorId: session?.user?.id ?? null,
  });
  return response;
}
