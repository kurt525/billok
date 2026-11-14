import { NextResponse } from 'next/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { checkRateLimit } from '@/server/lib/rate-limit';
import { getClientIp } from '@/server/lib/client-ip';
import { ownerSessionFingerprint } from '@/server/lib/owner-passkey-action-approval';
import { renameOwnerPasskey } from '@/server/lib/owner-passkey-management';

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
  if (
    !checkRateLimit('owner-manage-rename:' + session.user.id, 12, 60 * 60 * 1000).allowed ||
    !checkRateLimit('owner-manage-rename-ip:' + getClientIp(request.headers), 32, 60 * 60 * 1000).allowed
  ) {
    return NextResponse.json({ error: 'Слишком много попыток.' }, { status: 429 });
  }
  try {
    const raw = await request.text();
    if (raw.length > 4096) return denied();
    const body = JSON.parse(raw) as {
      targetId?: unknown;
      approvalToken?: unknown;
      label?: unknown;
    };
    if (typeof body.targetId !== 'string') return denied();
    const result = await renameOwnerPasskey({
      db,
      userId: session.user.id,
      sessionHash: ownerSessionFingerprint(request.headers),
      targetId: body.targetId,
      label: body.label,
      approvalToken: body.approvalToken,
    });
    return NextResponse.json(result);
  } catch {
    // Do not disclose which account/key/approval was invalid.
    return denied();
  }
}
