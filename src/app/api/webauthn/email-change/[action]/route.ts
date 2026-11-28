import { createHmac } from 'node:crypto';
import { after } from 'next/server';
import { processEmailChangeNotifications } from '@/server/lib/email-change-notification';
import { getToken } from 'next-auth/jwt';
import { z } from 'zod';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { trustedApiMutation } from '@/lib/api-request-security';
import { readBillokWebAuthnRelyingParty } from '@/server/lib/webauthn-relying-party';
import { readBoundedJson } from '@/server/lib/read-bounded-json';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit, checkTokenRateLimit } from '@/server/lib/rate-limit';
import { AppError } from '@/server/lib/app-error';
import {
  approveEmailChange,
  beginEmailChange,
  cancelEmailChange,
  completeEmailChange,
  emailChangeStatus,
  emailChangeDigest,
  type EmailChangeSession,
} from '@/server/lib/email-change';
import { logger } from '@/server/lib/logger';

const headers = { 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer' };
const actions = ['status', 'start', 'approve', 'cancel', 'complete'] as const;
type Action = (typeof actions)[number];
const actionLabels: Record<Action, string> = {
  status: 'EMAIL_CHANGE_STATUS',
  start: 'EMAIL_CHANGE_STARTED',
  approve: 'EMAIL_CHANGE_REQUESTED',
  cancel: 'EMAIL_CHANGE_CANCELLED',
  complete: 'EMAIL_CHANGE_COMPLETED',
};

async function readSession(request: Request): Promise<EmailChangeSession> {
  const cookie = request.headers.get('cookie') ?? '';
  if (/(?:^|;\s*)sharetab-impersonate=/u.test(cookie)) throw new AppError('FORBIDDEN');
  const secure = /(?:^|;\s*)__Secure-authjs\.session-token(?:\.\d+)?=/u.test(cookie);
  const regular = /(?:^|;\s*)authjs\.session-token(?:\.\d+)?=/u.test(cookie);
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32 || secure === regular) throw new AppError('FORBIDDEN');
  const session = await auth();
  const token = await getToken({
    req: request,
    secret,
    cookieName: secure ? '__Secure-authjs.session-token' : 'authjs.session-token',
  });
  if (
    !session?.user?.id ||
    !token ||
    token.id !== session.user.id ||
    token.sessionSecurityValid !== true ||
    typeof token.sessionSecurityVersion !== 'number' ||
    !Number.isSafeInteger(token.sessionSecurityVersion) ||
    token.sessionSecurityVersion < 0 ||
    typeof token.impersonationSessionNonce !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(token.impersonationSessionNonce)
  )
    throw new AppError('FORBIDDEN');
  return {
    userId: session.user.id,
    version: token.sessionSecurityVersion,
    binding: createHmac('sha256', secret)
      .update('billok:email-change-session:v1:')
      .update(token.impersonationSessionNonce)
      .digest('hex'),
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action: rawAction } = await params;
  if (!(actions as readonly string[]).includes(rawAction))
    return Response.json({ error: 'Операция недоступна.' }, { status: 404, headers });
  const action = rawAction as Action;
  let actorId: string | null = null;
  let auditAllowed = false;
  try {
    const rp = readBillokWebAuthnRelyingParty(process.env);
    const url = new URL(request.url);
    if (
      url.search ||
      !trustedApiMutation(
        {
          method: 'POST',
          pathname: '/api/webauthn/email-change/' + action,
          headers: request.headers,
          search: url.search,
        },
        rp.origin,
      ) ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      throw new AppError('FORBIDDEN');
    const ip = getClientIp(request.headers);
    if (!checkTokenRateLimit('email-change-ip:' + emailChangeDigest(ip), 120, 15 * 60_000).allowed)
      throw new AppError('TOO_MANY_REQUESTS');
    auditAllowed = true;
    const session = await readSession(request);
    actorId = session.userId;
    if (
      !checkRateLimit(
        'email-change:' + action + ':' + session.userId,
        action === 'status' ? 120 : action === 'start' || action === 'approve' ? 6 : 12,
        60 * 60_000,
      ).allowed
    )
      throw new AppError('TOO_MANY_REQUESTS');
    const data = await readBoundedJson(request, 24_576);
    if (data === null) throw new AppError('BAD_REQUEST');
    const input = { db, session };
    let result: unknown;
    if (action === 'start') {
      const parsed = z.strictObject({ email: z.string().max(254) }).parse(data);
      if (
        !checkTokenRateLimit('email-change-address:' + emailChangeDigest(parsed.email.toLowerCase()), 12, 60 * 60_000)
          .allowed
      )
        throw new AppError('TOO_MANY_REQUESTS');
      result = { options: await beginEmailChange({ ...input, email: parsed.email }) };
    } else if (action === 'approve') {
      const parsed = z
        .strictObject({
          response: z.custom<AuthenticationResponseJSON>((v) => !!v && typeof v === 'object' && !Array.isArray(v)),
        })
        .parse(data);
      result = await approveEmailChange({ ...input, response: parsed.response });
    } else if (action === 'complete') {
      const parsed = z.strictObject({ token: z.string().length(43) }).parse(data);
      result = await completeEmailChange({ ...input, token: parsed.token });
      // Return the committed outcome first. The durable outbox and periodic
      // maintenance cover process crashes and transient SMTP failures.
      try {
        after(async () => {
          try {
            await processEmailChangeNotifications(db);
          } catch {
            logger.warn('auth.email_change_maintenance_failed');
          }
        });
      } catch {
        logger.warn('auth.email_change_maintenance_schedule_failed');
      }
    } else {
      z.strictObject({}).parse(data);
      result = action === 'cancel' ? await cancelEmailChange(input) : await emailChangeStatus(input);
    }
    return Response.json(result, { headers });
  } catch (error) {
    // No serialized input, email, cookies, token or library error message.
    if (
      action !== 'status' &&
      auditAllowed &&
      checkTokenRateLimit(
        'email-change-denied:' + emailChangeDigest(actorId ?? getClientIp(request.headers)),
        30,
        60 * 60_000,
      ).allowed
    ) {
      try {
        await db.securityEvent.create({ data: { actorId, action: actionLabels[action], outcome: 'DENIED' } });
      } catch {
        logger.warn('auth.email_change_audit_failed');
      }
    }
    const code =
      error instanceof AppError
        ? error.code
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 'BAD_REQUEST'
          : 'INTERNAL_SERVER_ERROR';
    if (code === 'TOO_MANY_REQUESTS')
      return Response.json({ error: 'Слишком много попыток. Повторите позже.' }, { status: 429, headers });
    if (code === 'CONFLICT')
      return Response.json({ error: 'Этот адрес недоступен. Укажите другой.' }, { status: 409, headers });
    if (code === 'BAD_REQUEST')
      return Response.json(
        { error: 'Проверьте новый адрес: требуется другой корректный email в зоне .ru или .su.' },
        { status: 400, headers },
      );
    if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED')
      return Response.json(
        { error: 'Операция недоступна или срок подтверждения истёк. Начните смену заново.' },
        { status: 403, headers },
      );
    logger.warn('auth.email_change_failed', { action });
    return Response.json({ error: 'Не удалось выполнить операцию. Повторите позже.' }, { status: 503, headers });
  }
}
