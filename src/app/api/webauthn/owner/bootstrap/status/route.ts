import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { NextResponse } from 'next/server';
import { OWNER_BOOTSTRAP_SINGLETON_ID } from '@/server/lib/owner-bootstrap';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return new Response(null, { status: 401 });
  const owner = await db.ownerBootstrap.findUnique({
    where: { id: OWNER_BOOTSTRAP_SINGLETON_ID },
    select: { userId: true, completedAt: true },
  });
  if (!owner || owner.userId !== session.user.id) return new Response(null, { status: 403 });
  const activeKeys = await db.passkeyCredential.count({
    where: { userId: owner.userId, revokedAt: null },
  });
  return NextResponse.json({
    firstKeyAdded: activeKeys >= 1,
    completed: Boolean(owner.completedAt && activeKeys >= 2),
  });
}
