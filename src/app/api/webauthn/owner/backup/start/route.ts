import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { NextResponse } from 'next/server';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { beginOwnerBackupPasskey, OWNER_BACKUP_BINDING_COOKIE } from '@/server/lib/owner-backup-passkey';
import { newWebAuthnBindingSecret } from '@/server/lib/webauthn-registration';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from '@/server/lib/webauthn-relying-party';

export async function POST(request: Request) {
  const rp = readBillokWebAuthnRelyingParty(process.env);
  if (request.headers.get('origin') !== rp.origin) return new Response(null, { status: 403 });
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 401 });
  if (!checkRateLimit('owner-backup-start:' + getClientIp(request.headers), 8, 60 * 60 * 1000).allowed) {
    return new Response(null, { status: 429 });
  }
  try {
    const secret = newWebAuthnBindingSecret();
    const options = await beginOwnerBackupPasskey({
      db,
      userId: session.user.id,
      bindingSecret: secret,
    });
    const response = NextResponse.json({ options });
    response.cookies.set(OWNER_BACKUP_BINDING_COOKIE, secret, {
      path: '/api/webauthn/owner/backup',
      secure: rp.origin.startsWith('https:'),
      httpOnly: true,
      sameSite: 'strict',
      maxAge: WEBAUTHN_CHALLENGE_TTL_MS / 1000,
    });
    return response;
  } catch {
    return new Response(null, { status: 403 });
  }
}
