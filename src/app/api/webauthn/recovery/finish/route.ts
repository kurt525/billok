import { NextResponse } from 'next/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { db } from '@/server/db';
import { recordOwnerSecurityEvent } from '@/server/lib/security-event-audit';
import { finishPasskeyRecovery, PASSKEY_RECOVERY_BINDING_COOKIE } from '@/server/lib/passkey-email-recovery';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { readBillokWebAuthnRelyingParty } from '@/server/lib/webauthn-relying-party';
import { readBoundedJson } from '@/server/lib/read-bounded-json';

async function performRecoveryPost(request: Request) {
  const denied = () => NextResponse.json({ error: 'Не удалось подтвердить новый Passkey.' }, { status: 403 });
  if (!checkRateLimit('passkey-recovery-finish:' + getClientIp(request.headers), 20, 60 * 60 * 1000).allowed) {
    return denied();
  }
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(PASSKEY_RECOVERY_BINDING_COOKIE + '='));
  const bindingSecret = cookie?.slice(PASSKEY_RECOVERY_BINDING_COOKIE.length + 1);
  if (!bindingSecret) return denied();
  try {
    const body = await readBoundedJson(request, 35_000);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2) return denied();
    const { token, credential } = body as { token?: unknown; credential?: RegistrationResponseJSON };
    if (
      typeof token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(token) ||
      !credential ||
      typeof credential !== 'object' ||
      Array.isArray(credential)
    )
      return denied();
    const result = await finishPasskeyRecovery({
      db,
      token,
      bindingSecret,
      response: credential,
      env: process.env,
    });
    const ok = NextResponse.json(result);
    ok.cookies.set(PASSKEY_RECOVERY_BINDING_COOKIE, '', {
      path: '/api/webauthn/recovery',
      httpOnly: true,
      sameSite: 'strict',
      secure: readBillokWebAuthnRelyingParty(process.env).origin.startsWith('https:'),
      maxAge: 0,
    });
    return ok;
  } catch {
    return denied();
  }
}

export async function POST(request: Request) {
  let response: Response;
  try {
    response = await performRecoveryPost(request);
  } catch {
    response = new Response('Доступ запрещён', { status: 403 });
  }
  await recordOwnerSecurityEvent({
    db,
    action: 'PASSKEY_RECOVERY_FINISH',
    outcome: response.status >= 400 ? 'DENIED' : 'ALLOWED',
    actorId: null,
  });
  return response;
}
