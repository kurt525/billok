import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';
import { cookies } from 'next/headers';
import { auth } from '../auth';
import { db } from '../db';
import { logger } from '../lib/logger';
import { currentImpersonationSessionBinding, verifiedImpersonationSession } from '../lib/impersonation-session';
import { AppError, errorShape } from '../lib/app-error';
import { LOCALE_HEADER, localeFromHeader } from '@/lib/locale-header';
import { defaultLocale } from '@/i18n/routing';

const IMPERSONATE_COOKIE = 'sharetab-impersonate';

export const createTRPCContext = async (opts?: { req?: Request }) => {
  const authenticatedSession = await auth();
  // The effective identity belongs to this tRPC request only. Never mutate
  // the original Auth.js result shared with authentication infrastructure.
  const session = authenticatedSession
    ? { ...authenticatedSession, ...(authenticatedSession.user ? { user: { ...authenticatedSession.user } } : {}) }
    : authenticatedSession;
  const headers = opts?.req?.headers ?? new Headers();

  let impersonating: ReturnType<typeof verifiedImpersonationSession> = null;
  try {
    const cookieStore = await cookies();
    const raw = cookieStore.get(IMPERSONATE_COOKIE)?.value;
    if (raw && session?.user?.id && opts?.req) {
      const binding = await currentImpersonationSessionBinding(opts.req, session.user.id);
      if (binding) {
        const data = verifiedImpersonationSession(raw, session.user.id, binding);
        if (data) {
          impersonating = data;
          // The owner JWT remains unchanged; only this tRPC request acts as the
          // target. All owner-only procedures reject an impersonation context.
          session.user = { ...session.user, id: data.targetId, name: data.targetName, email: data.targetEmail };
        }
      }
    }
  } catch {
    // Invalid/replayed/expired impersonation data never grants target access.
  }

  return { session, db, headers, impersonating, locale: localeFromHeader(headers.get(LOCALE_HEADER)) };
};

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  // Errors reach the person in the language of the page that called (#266)
  errorFormatter: ({ shape, error, ctx }) => errorShape(shape, error, ctx?.locale ?? defaultLocale),
});

// Procedures that poll frequently and would spam the log buffer
const QUIET_PATHS = new Set(['admin.getLogs', 'admin.getImpersonationStatus']);

const loggingMiddleware = t.middleware(async ({ path, type, next, ctx }) => {
  const start = Date.now();
  const userId = ctx.session?.user?.id;
  // Attribute impersonated requests to the real admin, not just the target
  const impersonatedBy = ctx.impersonating?.adminId;

  const result = await next();

  if (QUIET_PATHS.has(path)) return result;

  const durationMs = Date.now() - start;
  const ok = result.ok;

  if (ok) {
    logger.info('trpc.ok', { path, type, userId, durationMs, ...(impersonatedBy ? { impersonatedBy } : {}) });
  } else {
    logger.warn('trpc.error', {
      path,
      type,
      userId,
      durationMs,
      code: result.error.code,
      ...(impersonatedBy ? { impersonatedBy } : {}),
    });
  }

  return result;
});

export const createTRPCRouter = t.router;
export const publicProcedure = t.procedure.use(loggingMiddleware);

export const protectedProcedure = t.procedure.use(loggingMiddleware).use(async ({ ctx, next }) => {
  if (!ctx.session?.user?.id) {
    throw new AppError('UNAUTHORIZED');
  }

  const user = await ctx.db.user.findUnique({
    where: { id: ctx.session.user.id },
    select: { suspendedAt: true },
  });

  if (!user) {
    throw new AppError('UNAUTHORIZED');
  }

  if (user.suspendedAt) {
    throw new AppError('FORBIDDEN', 'accountSuspended');
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.session.user,
    },
  });
});

export const groupMemberProcedure = protectedProcedure
  .input(z.object({ groupId: z.string() }))
  .use(async ({ ctx, input, next }) => {
    const membership = await ctx.db.groupMember.findUnique({
      where: {
        userId_groupId: {
          userId: ctx.user.id,
          groupId: input.groupId,
        },
      },
    });
    // A placeholder removed from the group keeps their row (#284). Only an admin
    // impersonating one could get here with it.
    if (!membership || membership.removedAt) {
      throw new AppError('FORBIDDEN', 'notGroupMember');
    }
    return next({ ctx: { ...ctx, membership } });
  });
