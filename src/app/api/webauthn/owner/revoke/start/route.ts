import { NextResponse } from 'next/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { beginOwnerPasskeyRevocation, OWNER_REVOKE_BINDING_COOKIE } from '@/server/lib/owner-passkey-revocation';
import { newWebAuthnBindingSecret } from '@/server/lib/webauthn-registration';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from '@/server/lib/webauthn-relying-party';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { getClientIp } from '@/server/lib/client-ip';

export async function POST(request: Request) {
  const denied = () => NextResponse.json({ error: 'Доступ к отзыву ключа запрещён.' }, { status: 403 });
  const session = await auth();
  if (!session?.user?.id || (request.headers.get('cookie') ?? '').includes('sharetab-impersonate=')) return denied();
  if (
    !checkRateLimit('owner-key-revoke-start:' + session.user.id, 8, 60 * 60 * 1000).allowed ||
    !checkRateLimit('owner-key-revoke-ip:' + getClientIp(request.headers), 25, 60 * 60 * 1000).allowed
  ) {
    return NextResponse.json({ error: 'Слишком много попыток. Повторите позже.' }, { status: 429 });
  }
  try {
    const raw = await request.text();
    if (raw.length > 256) return denied();
    const body = JSON.parse(raw) as { targetId?: unknown };
    if (typeof body.targetId !== 'string') return denied();
    const binding = newWebAuthnBindingSecret();
    const options = await beginOwnerPasskeyRevocation({
      db,
      ownerId: session.user.id,
      targetId: body.targetId,
      bindingSecret: binding,
      env: process.env,
    });
    const rp = readBillokWebAuthnRelyingParty(process.env);
    const response = NextResponse.json({ options });
    response.cookies.set(OWNER_REVOKE_BINDING_COOKIE, binding, {
      path: '/api/webauthn/owner/revoke',
      httpOnly: true,
      sameSite: 'strict',
      secure: rp.origin.startsWith('https:'),
      maxAge: WEBAUTHN_CHALLENGE_TTL_MS / 1000,
    });
    return response;
  } catch {
    return denied();
  }
}
