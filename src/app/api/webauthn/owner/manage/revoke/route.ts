import { NextResponse } from 'next/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { allowOwnerWebAuthnRequest } from '@/server/lib/owner-webauthn-burst';
import { ownerSessionFingerprint } from '@/server/lib/owner-passkey-action-approval';
import { revokeApprovedOwnerPasskey } from '@/server/lib/owner-passkey-management';

export async function POST(request: Request) {
  const denied = () =>
    NextResponse.json(
      {
        error: 'Действие с Passkey не подтверждено.',
      },
      { status: 403 },
    );
  const session = await auth();
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
  if (!allowOwnerWebAuthnRequest(session.user.id, 'manage-revoke')) {
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
      Object.keys(body).length !== 2 ||
      typeof (body as { targetId?: unknown }).targetId !== 'string' ||
      !(body as { targetId: string }).targetId ||
      (body as { targetId: string }).targetId.length > 128 ||
      typeof (body as { approvalToken?: unknown }).approvalToken !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test((body as { approvalToken: string }).approvalToken)
    )
      return denied();
    const valid = body as { targetId: string; approvalToken: string };
    const result = await revokeApprovedOwnerPasskey({
      db,
      userId: session.user.id,
      sessionHash: ownerSessionFingerprint(request.headers),
      targetId: valid.targetId,
      approvalToken: valid.approvalToken,
    });
    return NextResponse.json(result);
  } catch {
    // Do not disclose which account/key/approval was invalid.
    return denied();
  }
}
