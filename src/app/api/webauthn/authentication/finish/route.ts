import { NextResponse } from 'next/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { db } from '@/server/db';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { finishPasskeyLogin, WEBAUTHN_LOGIN_BINDING_COOKIE } from '@/server/lib/passkey-login';

export async function POST(request: Request) {
  const rejected = () => NextResponse.json({ error: 'Проверка ключа доступа не прошла.' }, { status: 403 });
  const ip = getClientIp(request.headers);
  if (!checkRateLimit('passkey-finish:' + ip, 25, 15 * 60 * 1000).allowed) {
    return NextResponse.json({ error: 'Слишком много попыток входа.' }, { status: 429 });
  }
  const header = request.headers.get('cookie') ?? '';
  const binding = header
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(WEBAUTHN_LOGIN_BINDING_COOKIE + '='));
  const bindingSecret = binding?.slice(WEBAUTHN_LOGIN_BINDING_COOKIE.length + 1);
  if (!bindingSecret) return rejected();
  try {
    const body = await request.text();
    if (body.length > 24_576) return rejected();
    const response = JSON.parse(body) as AuthenticationResponseJSON;
    const result = await finishPasskeyLogin({ db, bindingSecret, response });
    const ok = NextResponse.json(result);
    ok.cookies.set(WEBAUTHN_LOGIN_BINDING_COOKIE, '', {
      path: '/api/webauthn/authentication',
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 0,
    });
    return ok;
  } catch {
    return rejected();
  }
}
