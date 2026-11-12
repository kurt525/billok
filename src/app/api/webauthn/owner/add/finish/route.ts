import { NextResponse } from 'next/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { ownerSessionFingerprint } from '@/server/lib/owner-passkey-action-approval';
import { finishAdditionalOwnerPasskey, OWNER_ADD_BINDING_COOKIE } from '@/server/lib/owner-passkey-add';
import { readBillokWebAuthnRelyingParty } from '@/server/lib/webauthn-relying-party';

export async function POST(request: Request) {
  const denied = () => NextResponse.json({ error: 'Новый Passkey не подтверждён.' }, { status: 403 });
  const session = await auth();
  if (!session?.user?.id || (request.headers.get('cookie') ?? '').includes('sharetab-impersonate=')) return denied();
  // A valid server session is necessary, but not sufficient, for owner
  // operations: recheck the sole owner and current DB account state.
  try {
    await requireOwner(db, session.user.id);
  } catch {
    return denied();
  }
  if (
    !checkRateLimit('owner-add-key-finish:' + session.user.id, 15, 60 * 60 * 1000).allowed ||
    !checkRateLimit('owner-add-key-finish-ip:' + getClientIp(request.headers), 35, 60 * 60 * 1000).allowed
  ) {
    return NextResponse.json({ error: 'Слишком много попыток.' }, { status: 429 });
  }
  try {
    const secretCookie = (request.headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(OWNER_ADD_BINDING_COOKIE + '='));
    if (!secretCookie) return denied();
    const secret = secretCookie.slice(OWNER_ADD_BINDING_COOKIE.length + 1);
    const raw = await request.text();
    if (raw.length > 35_000) return denied();
    const payload = JSON.parse(raw) as {
      approvalToken?: unknown;
      response?: RegistrationResponseJSON;
    };
    if (!payload.response) return denied();
    const result = await finishAdditionalOwnerPasskey({
      db,
      userId: session.user.id,
      sessionHash: ownerSessionFingerprint(request.headers),
      bindingSecret: secret,
      approvalToken: payload.approvalToken,
      response: payload.response,
    });
    const response = NextResponse.json(result);
    response.cookies.set(OWNER_ADD_BINDING_COOKIE, '', {
      path: '/api/webauthn/owner/add',
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
