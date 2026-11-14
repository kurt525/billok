import { NextResponse } from 'next/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { allowOwnerWebAuthnRequest } from '@/server/lib/owner-webauthn-burst';
import { newWebAuthnBindingSecret } from '@/server/lib/webauthn-registration';
import {
  beginOwnerPasskeyActionApproval,
  ownerSessionFingerprint,
  OWNER_APPROVAL_BINDING_COOKIE,
  isOwnerPasskeyAction,
} from '@/server/lib/owner-passkey-action-approval';
import { readBillokWebAuthnRelyingParty, WEBAUTHN_CHALLENGE_TTL_MS } from '@/server/lib/webauthn-relying-party';

export async function POST(request: Request) {
  const denied = () => NextResponse.json({ error: 'Повторная проверка владельца не разрешена.' }, { status: 403 });
  const session = await auth();
  if (!session?.user?.id || (request.headers.get('cookie') ?? '').includes('sharetab-impersonate=')) return denied();
  // A valid server session is necessary, but not sufficient, for owner
  // operations: recheck the sole owner and current DB account state.
  try {
    await requireOwner(db, session.user.id);
  } catch {
    return denied();
  }
  // Technical 2-second anti-flood, never an hourly limit on owner actions.
  if (!allowOwnerWebAuthnRequest(session.user.id, 'approval-start')) {
    return NextResponse.json({ error: 'Слишком много запросов подряд.' }, { status: 429 });
  }
  try {
    const raw = await request.text();
    if (raw.length > 512) return denied();
    const data = JSON.parse(raw) as { action?: unknown; targetId?: unknown };
    if (!isOwnerPasskeyAction(data.action)) return denied();
    if (data.targetId !== undefined && data.targetId !== null && typeof data.targetId !== 'string') return denied();
    const sessionHash = ownerSessionFingerprint(request.headers);
    const bindingSecret = newWebAuthnBindingSecret();
    const options = await beginOwnerPasskeyActionApproval({
      db,
      userId: session.user.id,
      sessionHash,
      bindingSecret,
      action: data.action,
      targetId: (data.targetId as string | null | undefined) ?? null,
    });
    const response = NextResponse.json({ options });
    response.cookies.set(OWNER_APPROVAL_BINDING_COOKIE, bindingSecret, {
      path: '/api/webauthn/owner/approval',
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
