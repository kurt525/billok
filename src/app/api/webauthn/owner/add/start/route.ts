import { NextResponse } from 'next/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { newWebAuthnBindingSecret } from '@/server/lib/webauthn-registration';
import { ownerSessionFingerprint } from '@/server/lib/owner-passkey-action-approval';
import { beginAdditionalOwnerPasskey, OWNER_ADD_BINDING_COOKIE } from '@/server/lib/owner-passkey-add';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from '@/server/lib/webauthn-relying-party';

export async function POST(request: Request) {
  const denied = () => NextResponse.json({ error: 'Добавление Passkey запрещено.' }, { status: 403 });
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
    !checkRateLimit('owner-add-key-start:' + session.user.id, 8, 60 * 60 * 1000).allowed ||
    !checkRateLimit('owner-add-key-start-ip:' + getClientIp(request.headers), 20, 60 * 60 * 1000).allowed
  ) {
    return NextResponse.json({ error: 'Слишком много попыток.' }, { status: 429 });
  }
  try {
    const raw = await request.text();
    if (raw.length > 256) return denied();
    const data = JSON.parse(raw) as { approvalToken?: unknown };
    const sessionHash = ownerSessionFingerprint(request.headers);
    const secret = newWebAuthnBindingSecret();
    const options = await beginAdditionalOwnerPasskey({
      db,
      userId: session.user.id,
      sessionHash,
      bindingSecret: secret,
      approvalToken: data.approvalToken,
    });
    const response = NextResponse.json({ options });
    response.cookies.set(OWNER_ADD_BINDING_COOKIE, secret, {
      path: '/api/webauthn/owner/add',
      httpOnly: true,
      sameSite: 'strict',
      secure: readBillokWebAuthnRelyingParty(process.env).origin.startsWith('https:'),
      maxAge: WEBAUTHN_CHALLENGE_TTL_MS / 1000,
    });
    return response;
  } catch {
    return denied();
  }
}
