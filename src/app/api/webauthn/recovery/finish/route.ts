import { NextResponse } from 'next/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { db } from '@/server/db';
import { finishPasskeyRecovery, PASSKEY_RECOVERY_BINDING_COOKIE } from '@/server/lib/passkey-email-recovery';
import { getClientIp } from '@/server/lib/client-ip';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { readBillokWebAuthnRelyingParty } from '@/server/lib/webauthn-relying-party';

export async function POST(request: Request) {
  const denied = () => NextResponse.json({ error: 'Не удалось подтвердить новый Passkey.' }, { status: 403 });
  if (!checkRateLimit('passkey-recovery-finish:' + getClientIp(request.headers), 20, 60 * 60 * 1000).allowed) {
    return denied();
  }
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(PASSKEY_RECOVERY_BINDING_COOKIE + '='));
  const bindingSecret = cookie?.slice(PASSKEY_RECOVERY_BINDING_COOKIE.length + 1);
  if (!bindingSecret) return denied();
  try {
    const raw = await request.text();
    if (raw.length > 35_000) return denied();
    const { token, credential } = JSON.parse(raw) as {
      token?: unknown;
      credential?: RegistrationResponseJSON;
    };
    if (typeof token !== 'string' || !credential || typeof credential !== 'object') return denied();
    const result = await finishPasskeyRecovery({
      db,
      token,
      bindingSecret,
      response: credential,
      env: process.env,
    });
    const ok = NextResponse.json(result);
    ok.cookies.set(PASSKEY_RECOVERY_BINDING_COOKIE, '', {
      path: '/api/webauthn/recovery',
      httpOnly: true,
      sameSite: 'strict',
      secure: readBillokWebAuthnRelyingParty(process.env).origin.startsWith('https:'),
      maxAge: 0,
    });
    return ok;
  } catch {
    return denied();
  }
}
