import { NextResponse } from 'next/server';
import { db } from '@/server/db';
import { beginPasskeyRecovery, PASSKEY_RECOVERY_BINDING_COOKIE } from '@/server/lib/passkey-email-recovery';
import { newWebAuthnBindingSecret } from '@/server/lib/webauthn-registration';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from '@/server/lib/webauthn-relying-party';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';

export async function POST(request: Request) {
  const denied = () => NextResponse.json({ error: 'Недействительная ссылка восстановления.' }, { status: 403 });
  if (!checkRateLimit('passkey-recovery-start:' + getClientIp(request.headers), 15, 60 * 60 * 1000).allowed) {
    return denied();
  }
  try {
    const raw = await request.text();
    if (raw.length > 512) return denied();
    const { token } = JSON.parse(raw) as { token?: unknown };
    if (typeof token !== 'string') return denied();
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
