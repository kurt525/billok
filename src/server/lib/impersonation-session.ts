import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getToken } from 'next-auth/jwt';
import { verifyAndParse } from './signed-cookie';

// Issue 6.12.3: each verified Passkey login has its own private JWT nonce.
// Neither a new login by the same owner nor a stale signed cookie may reuse it.
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IMPERSONATION_MAX_AGE_MS = 60 * 60_000;

export interface ImpersonationSession {
  adminId: string;
  adminEmail: string;
  targetId: string;
  targetName: string | null;
  targetEmail: string;
  sessionBinding: string;
  startedAt: string;
}

function canonicalNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !NONCE_PATTERN.test(value)) return false;
  const raw = Buffer.from(value, 'base64url');
  return raw.length === 32 && raw.toString('base64url') === value;
}

export function issueAuthSessionNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** Only a server-verified Auth.js JWT (not body/header claims) proves this Passkey session. */
export async function currentImpersonationSessionBinding(request: Request, userId: string): Promise<string | null> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32 || !userId) return null;
  const rawCookie = request.headers.get('cookie') ?? '';
  // Explicitly refuse ambiguous regular+Secure cookie combinations. Auth.js
  // chunked cookies are supported by getToken after selecting the proper name.
  const secure = /(?:^|;\s*)__Secure-authjs\.session-token(?:\.\d+)?=/.test(rawCookie);
  const regular = /(?:^|;\s*)authjs\.session-token(?:\.\d+)?=/.test(rawCookie);
  if (secure === regular) return null;
  try {
    const token = await getToken({
      req: request,
      secret,
      cookieName: secure ? '__Secure-authjs.session-token' : 'authjs.session-token',
    });
    if (
      token?.id !== userId ||
      token.sessionSecurityValid !== true ||
      !canonicalNonce(token.impersonationSessionNonce)
    ) {
      return null;
    }
    return createHmac('sha256', secret)
      .update('billok:impersonation-session:v1:')
      .update(token.impersonationSessionNonce)
      .digest('base64url');
  } catch {
    return null;
  }
}

/** Signed cookie must match this *specific* Passkey login, not merely owner userId. */
export function verifiedImpersonationSession(
  signed: string,
  currentUserId: string,
  sessionBinding: string,
  now = Date.now(),
): ImpersonationSession | null {
  if (!canonicalNonce(sessionBinding)) return null;
  const value = verifyAndParse<unknown>(signed);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    data.adminId !== currentUserId ||
    typeof data.adminEmail !== 'string' ||
    typeof data.targetId !== 'string' ||
    !data.targetId ||
    data.targetId === currentUserId ||
    (data.targetName !== null && typeof data.targetName !== 'string') ||
    typeof data.targetEmail !== 'string' ||
    typeof data.startedAt !== 'string' ||
    !canonicalNonce(data.sessionBinding)
  ) {
    return null;
  }
  const started = Date.parse(data.startedAt);
  if (!Number.isFinite(started) || started > now || now - started >= IMPERSONATION_MAX_AGE_MS) return null;
  const saved = Buffer.from(data.sessionBinding, 'base64url');
  const current = Buffer.from(sessionBinding, 'base64url');
  if (!timingSafeEqual(saved, current)) return null;
  return data as unknown as ImpersonationSession;
}
