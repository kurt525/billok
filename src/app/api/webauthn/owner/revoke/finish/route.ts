import { NextResponse } from 'next/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { finishOwnerPasskeyRevocation, OWNER_REVOKE_BINDING_COOKIE } from '@/server/lib/owner-passkey-revocation';
import { readBillokWebAuthnRelyingParty } from '@/server/lib/webauthn-relying-party';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { getClientIp } from '@/server/lib/client-ip';

export async function POST(request: Request) {
  const denied = () => NextResponse.json({ error: 'Подтверждение отзыва Passkey не прошло.' }, { status: 403 });
  const session = await auth();
  if (!session?.user?.id || (request.headers.get('cookie') ?? '').includes('sharetab-impersonate=')) return denied();
  if (
    !checkRateLimit('owner-key-revoke-finish:' + session.user.id, 16, 60 * 60 * 1000).allowed ||
    !checkRateLimit('owner-key-revoke-finish-ip:' + getClientIp(request.headers), 40, 60 * 60 * 1000).allowed
  ) {
    return NextResponse.json({ error: 'Слишком много попыток. Повторите позже.' }, { status: 429 });
  }
  const binding = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(OWNER_REVOKE_BINDING_COOKIE + '='));
  const secret = binding?.slice(OWNER_REVOKE_BINDING_COOKIE.length + 1);
  if (!secret) return denied();
  try {
    const raw = await request.text();
    if (raw.length > 24_576) return denied();
    const assertion = JSON.parse(raw) as AuthenticationResponseJSON;
    const result = await finishOwnerPasskeyRevocation({
      db,
      ownerId: session.user.id,
      bindingSecret: secret,
      response: assertion,
      env: process.env,
    });
    const response = NextResponse.json(result);
    response.cookies.set(OWNER_REVOKE_BINDING_COOKIE, '', {
      path: '/api/webauthn/owner/revoke',
      httpOnly: true,
      sameSite: 'strict',
      secure: readBillokWebAuthnRelyingParty(process.env).origin.startsWith('https:'),
      maxAge: 0,
    });
    return response;
  } catch {
    return denied();
  }
}
