import { NextResponse } from 'next/server';
import { db } from '@/server/db';
import { beginPasskeyRecovery, PASSKEY_RECOVERY_BINDING_COOKIE } from '@/server/lib/passkey-email-recovery';
import { newWebAuthnBindingSecret } from '@/server/lib/webauthn-registration';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from '@/server/lib/webauthn-relying-party';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { readBoundedJson } from '@/server/lib/read-bounded-json';

export async function POST(request: Request) {
  const denied = () => NextResponse.json({ error: 'Недействительная ссылка восстановления.' }, { status: 403 });
  if (!checkRateLimit('passkey-recovery-start:' + getClientIp(request.headers), 15, 60 * 60 * 1000).allowed) {
    return denied();
  }
  try {
    const body = await readBoundedJson(request, 512);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { token?: unknown }).token !== 'string'
    )
      return denied();
    const token = (body as { token: string }).token;
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return denied();
    const binding = newWebAuthnBindingSecret();
    const options = await beginPasskeyRecovery({ db, token, bindingSecret: binding, env: process.env });
    const rp = readBillokWebAuthnRelyingParty(process.env);
    const result = NextResponse.json({ options });
    result.cookies.set(PASSKEY_RECOVERY_BINDING_COOKIE, binding, {
      path: '/api/webauthn/recovery',
      httpOnly: true,
      sameSite: 'strict',
      secure: rp.origin.startsWith('https:'),
      maxAge: WEBAUTHN_CHALLENGE_TTL_MS / 1000,
    });
    return result;
  } catch {
    return denied();
  }
}
