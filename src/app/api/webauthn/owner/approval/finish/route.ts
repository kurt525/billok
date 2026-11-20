import { NextResponse } from 'next/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Session } from 'next-auth';
import { auth } from '@/server/auth';
import { recordOwnerSecurityEvent } from '@/server/lib/security-event-audit';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { allowOwnerWebAuthnRequest } from '@/server/lib/owner-webauthn-burst';
import {
  finishOwnerPasskeyActionApproval,
  ownerSessionFingerprint,
  OWNER_APPROVAL_BINDING_COOKIE,
} from '@/server/lib/owner-passkey-action-approval';
import { readBillokWebAuthnRelyingParty } from '@/server/lib/webauthn-relying-party';

async function performAuditedOwnerPost(request: Request, session: Session | null) {
  const denied = () => NextResponse.json({ error: 'Подтверждение владельца отклонено.' }, { status: 403 });
  if (!session?.user?.id || (request.headers.get('cookie') ?? '').includes('sharetab-impersonate=')) return denied();
  // A valid server session is necessary, but not sufficient, for owner
  // operations: recheck the sole owner and current DB account state.
  try {
    await requireOwner(db, session.user.id);
  } catch {
    return denied();
  }
  // Technical 2-second anti-flood, never an hourly limit on owner actions.
  if (!allowOwnerWebAuthnRequest(session.user.id, 'approval-finish')) {
    return NextResponse.json({ error: 'Слишком много запросов подряд.' }, { status: 429 });
  }
  try {
    const binding = (request.headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(OWNER_APPROVAL_BINDING_COOKIE + '='));
    if (!binding) return denied();
    const bindingSecret = binding.slice(OWNER_APPROVAL_BINDING_COOKIE.length + 1);
    const raw = await request.text();
    if (raw.length > 24_576) return denied();
    const result = await finishOwnerPasskeyActionApproval({
      db,
      userId: session.user.id,
      sessionHash: ownerSessionFingerprint(request.headers),
      bindingSecret,
      response: JSON.parse(raw) as AuthenticationResponseJSON,
    });
    const response = NextResponse.json(result);
    response.cookies.set(OWNER_APPROVAL_BINDING_COOKIE, '', {
      path: '/api/webauthn/owner/approval',
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

export async function POST(request: Request) {
  const session = await auth().catch(() => null);
  let response: Response;
  try {
    response = await performAuditedOwnerPost(request, session);
  } catch {
    response = Response.json({ error: 'Доступ запрещён' }, { status: 403 });
  }
  // Successful audit is a separate durable security event; the existing
  // transaction-bound AdminAuditLog remains authoritative for mutations.
  // Denied requests are recorded OUTSIDE rolled-back transactions.
  await recordOwnerSecurityEvent({
    db,
    action: 'OWNER_APPROVAL_VERIFIED',
    outcome: response.status >= 400 ? 'DENIED' : 'ALLOWED',
    actorId: session?.user?.id ?? null,
  });
  return response;
}
