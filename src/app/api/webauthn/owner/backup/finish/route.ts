import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { NextResponse } from 'next/server';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { finishOwnerBackupPasskey, OWNER_BACKUP_BINDING_COOKIE } from '@/server/lib/owner-backup-passkey';
import { readBillokWebAuthnRelyingParty } from '@/server/lib/webauthn-relying-party';

export async function POST(request: Request) {
  const rp = readBillokWebAuthnRelyingParty(process.env);
  if (request.headers.get('origin') !== rp.origin) return new Response(null, { status: 403 });
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 401 });
  if (!checkRateLimit('owner-backup-finish:' + getClientIp(request.headers), 12, 60 * 60 * 1000).allowed) {
    return new Response(null, { status: 429 });
  }
  const pair = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(OWNER_BACKUP_BINDING_COOKIE + '='));
  const secret = pair?.slice(OWNER_BACKUP_BINDING_COOKIE.length + 1);
  if (!secret) return new Response(null, { status: 403 });
  try {
    const raw = await request.text();
    if (raw.length > 32_768) return new Response(null, { status: 403 });
    const result = await finishOwnerBackupPasskey({
      db,
      userId: session.user.id,
      bindingSecret: secret,
      response: JSON.parse(raw) as RegistrationResponseJSON,
    });
    const ok = NextResponse.json(result);
    ok.cookies.set(OWNER_BACKUP_BINDING_COOKIE, '', {
      path: '/api/webauthn/owner/backup',
      httpOnly: true,
      sameSite: 'strict',
      secure: rp.origin.startsWith('https:'),
      maxAge: 0,
    });
    return ok;
  } catch {
    return new Response(null, { status: 403 });
  }
}
