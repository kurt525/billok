import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { auth } from '@/server/auth';
import { recordOwnerSecurityEvent } from '@/server/lib/security-event-audit';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { allowOwnerWebAuthnRequest } from '@/server/lib/owner-webauthn-burst';
import { ownerSessionFingerprint } from '@/server/lib/owner-passkey-action-approval';
import { renameOwnerPasskey } from '@/server/lib/owner-passkey-management';

async function performAuditedOwnerPost(request: Request, session: Session | null) {
  const denied = () =>
    NextResponse.json(
      {
        error: 'Действие с Passkey не подтверждено.',
      },
      { status: 403 },
    );
  if (!session?.user?.id || (request.headers.get('cookie') ?? '').includes('sharetab-impersonate=')) {
    return denied();
  }
  // A valid server session is necessary, but not sufficient, for owner
  // operations: recheck the sole owner and current DB account state.
  try {
    await requireOwner(db, session.user.id);
  } catch {
    return denied();
  }
  // One brief per-owner anti-flood window, NOT an hourly/daily quota.
  // Shared NAT/VPN IP activity cannot block legitimate owner operations.
  if (!allowOwnerWebAuthnRequest(session.user.id, 'manage-rename')) {
    return NextResponse.json({ error: 'Слишком много запросов подряд.' }, { status: 429 });
  }
  try {
    const raw = await request.text();
    if (raw.length > 4096) return denied();
    const body: unknown = JSON.parse(raw);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 3 ||
      typeof (body as { targetId?: unknown }).targetId !== 'string' ||
      !(body as { targetId: string }).targetId ||
      (body as { targetId: string }).targetId.length > 128 ||
      typeof (body as { approvalToken?: unknown }).approvalToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test((body as { approvalToken: string }).approvalToken) ||
      typeof (body as { label?: unknown }).label !== 'string'
    )
      return denied();
    const valid = body as { targetId: string; label: string; approvalToken: string };
    const result = await renameOwnerPasskey({
      db,
      userId: session.user.id,
      sessionHash: ownerSessionFingerprint(request.headers),
      targetId: valid.targetId,
      label: valid.label,
      approvalToken: valid.approvalToken,
    });
    return NextResponse.json(result);
  } catch {
    // Do not disclose which account/key/approval was invalid.
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
    action: 'OWNER_PASSKEY_RENAMED',
    outcome: response.status >= 400 ? 'DENIED' : 'ALLOWED',
    actorId: session?.user?.id ?? null,
  });
  return response;
}
