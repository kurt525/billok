import { cookies } from 'next/headers';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { logAdminAction } from '@/server/trpc/routers/admin';
import { signPayload } from '@/server/lib/signed-cookie';
import { currentImpersonationSessionBinding, verifiedImpersonationSession } from '@/server/lib/impersonation-session';

const COOKIE_NAME = 'sharetab-impersonate';

/**
 * POST /api/admin/impersonate
 * Body: { userId: string }
 * Sets impersonation cookie so tRPC context switches effective user.
 */
export async function POST(req: Request) {
  const session = await auth();
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

  const body: unknown = await req.json().catch(() => null);
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as { userId?: unknown }).userId !== 'string'
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

  const targetUser = await db.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, name: true, email: true },
  });

  if (!targetUser) {
    return Response.json({ error: 'Пользователь не найден' }, { status: 404 });
  }

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

  await logAdminAction(db, session.user.id, 'IMPERSONATION_STARTED', targetUserId, {
    targetEmail: targetUser.email,
    targetName: targetUser.name,
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
