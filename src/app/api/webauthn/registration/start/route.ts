import { NextResponse } from 'next/server';
import { db } from '@/server/db';
import { hashEmailVerificationToken } from '@/server/lib/email-verification-token';
import { confirmRegistrationEmail } from '@/server/lib/registration-email-confirmation';
import {
  beginFirstPasskeyRegistration,
  newWebAuthnBindingSecret,
  WEBAUTHN_BINDING_COOKIE,
} from '@/server/lib/webauthn-registration';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { getClientIp } from '@/server/lib/client-ip';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from '@/server/lib/webauthn-relying-party';

export async function POST(request: Request) {
  const rejected = () =>
    NextResponse.json({ error: 'Не удалось подтвердить адрес для настройки ключа доступа.' }, { status: 400 });
  const ip = getClientIp(request.headers);
  if (!checkRateLimit('webauthn-enroll-start:' + ip, 10, 60 * 60 * 1000).allowed) {
    return NextResponse.json({ error: 'Слишком много попыток.' }, { status: 429 });
  }
  try {
    const payload = await request.text();
    if (payload.length > 512) return rejected();
    const data = JSON.parse(payload) as { token?: unknown };
    if (typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(data.token)) return rejected();
    // Read the target while the token is unconsumed. Only a successful atomic
    // email confirmation is allowed to proceed to passkey setup.
    const confirmation = await db.emailVerificationRequest.findUnique({
      where: { tokenHash: hashEmailVerificationToken(data.token) },
      select: { userId: true },
    });
    if (!confirmation || !(await confirmRegistrationEmail(db, data.token))) return rejected();

    const rp = readBillokWebAuthnRelyingParty(process.env);
    const binding = newWebAuthnBindingSecret();
    const options = await beginFirstPasskeyRegistration({
      db,
      userId: confirmation.userId,
      bindingSecret: binding,
    });
    const response = NextResponse.json({ options });
    response.cookies.set(WEBAUTHN_BINDING_COOKIE, binding, {
      path: '/api/webauthn',
      httpOnly: true,
      sameSite: 'strict',
      secure: rp.origin.startsWith('https:'),
      maxAge: WEBAUTHN_CHALLENGE_TTL_MS / 1000,
    });
    return response;
  } catch {
    // Never disclose email, invite, challenge or credential details.
    return rejected();
  }
}
