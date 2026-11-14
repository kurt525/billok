import { NextResponse } from 'next/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { db } from '@/server/db';
import { finishFirstPasskeyRegistration, WEBAUTHN_BINDING_COOKIE } from '@/server/lib/webauthn-registration';

export async function POST(request: Request) {
  const denied = () =>
    NextResponse.json({ error: 'Ключ доступа не подтверждён. Попробуйте ещё раз.' }, { status: 403 });
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(WEBAUTHN_BINDING_COOKIE + '='));
  const secret = cookie?.slice(WEBAUTHN_BINDING_COOKIE.length + 1);
  if (!secret) return denied();
  try {
    const body = await request.text();
    if (body.length > 32_768) return denied();
    const response = JSON.parse(body) as RegistrationResponseJSON;
    const result = await finishFirstPasskeyRegistration({ db, bindingSecret: secret, response });
    const ok = NextResponse.json(result);
    ok.cookies.set(WEBAUTHN_BINDING_COOKIE, '', {
      path: '/api/webauthn',
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 0,
    });
    return ok;
  } catch {
    return denied();
  }
}
