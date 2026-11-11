import { NextResponse } from 'next/server';
import { db } from '@/server/db';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { beginPasskeyLogin, WEBAUTHN_LOGIN_BINDING_COOKIE } from '@/server/lib/passkey-login';
import { newWebAuthnBindingSecret } from '@/server/lib/webauthn-registration';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from '@/server/lib/webauthn-relying-party';

export async function POST(request: Request) {
  const ip = getClientIp(request.headers);
  if (!checkRateLimit('passkey-start:' + ip, 20, 60 * 60 * 1000).allowed) {
    return NextResponse.json({ error: 'Слишком много попыток входа.' }, { status: 429 });
  }
  try {
    const bindingSecret = newWebAuthnBindingSecret();
    const options = await beginPasskeyLogin({ db, bindingSecret });
    const rp = readBillokWebAuthnRelyingParty(process.env);
    const result = NextResponse.json({ options });
    result.cookies.set(WEBAUTHN_LOGIN_BINDING_COOKIE, bindingSecret, {
      path: '/api/webauthn/authentication',
      secure: rp.origin.startsWith('https:'),
      httpOnly: true,
      sameSite: 'strict',
      maxAge: WEBAUTHN_CHALLENGE_TTL_MS / 1000,
    });
    return result;
  } catch {
    return NextResponse.json({ error: 'Не удалось подготовить вход с ключом доступа.' }, { status: 400 });
  }
}
