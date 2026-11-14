import { auth } from '@/server/auth';
import { cookies } from 'next/headers';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { AppError } from '@/server/lib/app-error';
import { ownerSessionFingerprint, consumeOwnerPasskeyActionProof } from '@/server/lib/owner-passkey-action-approval';

// No GET export: old links and browser prefetch cannot bypass Passkey.
export async function GET() {
  return new Response('Требуется подтверждение Passkey', {
    status: 405,
    headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: Request) {
  // Owner privileges are bound to the immutable DB user ID, not email.
  const session = await auth();
  if (!session?.user?.id) return new Response('Доступ запрещён', { status: 403 });
  // Auth.js still sees the real owner while impersonating; block owner REST
  // exports whenever the mode cookie is present (even if forged/expired).
  if ((await cookies()).get('sharetab-impersonate')) {
    return new Response('Доступ запрещён', { status: 403 });
  }
  try {
    await requireOwner(db, session.user.id);
  } catch {
    return new Response('Доступ запрещён', { status: 403 });
  }

  const body: unknown = await req.json().catch(() => null);
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as { approvalToken?: unknown }).approvalToken !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test((body as { approvalToken: string }).approvalToken)
  )
    return new Response('Доступ запрещён', { status: 403 });

  try {
    const sessionHash = ownerSessionFingerprint(req.headers);
    const exportData = await db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', session.user.id);
        await requireOwner(tx, session.user.id);
        await consumeOwnerPasskeyActionProof(tx, {
          userId: session.user.id,
          action: 'ADMIN_EXPORT',
          targetId: 'all-data:v1',
          sessionHash,
          approvalToken: (body as { approvalToken: string }).approvalToken,
        });
        // Read data only after signature proof; audit is in the same transaction.
        // Fetch all data in parallel (exclude password hashes)
        const [
          users,
          groups,
          groupMembers,
          groupInvites,
          expenses,
          expenseShares,
          settlements,
          receipts,
          receiptItems,
          activityLogs,
          guestSplits,
          systemSettings,
          systemInvites,
          adminAuditLogs,
        ] = await Promise.all([
          tx.user.findMany({
            select: {
              id: true,
              name: true,
              email: true,
              emailVerified: true,
              image: true,
              defaultCurrency: true,
              isPlaceholder: true,
              placeholderName: true,
              createdByUserId: true,
              suspendedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          tx.group.findMany(),
          tx.groupMember.findMany(),
          tx.groupInvite.findMany(),
          tx.expense.findMany(),
          tx.expenseShare.findMany(),
          tx.settlement.findMany(),
          tx.receipt.findMany({
            select: {
              id: true,
              imagePath: true,
              originalName: true,
              mimeType: true,
              fileSize: true,
              status: true,
              extractedData: true,
              groupId: true,
              savedById: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          tx.receiptItem.findMany(),
          tx.activityLog.findMany(),
          tx.guestSplit.findMany(),
          tx.systemSetting.findMany(),
          tx.systemInvite.findMany(),
          tx.adminAuditLog.findMany(),
        ]);

        const exportData = {
          exportedAt: new Date().toISOString(),
          exportedBy: session.user.email,
          version: '1.0',
          data: {
            users,
            groups,
            groupMembers,
            groupInvites,
            expenses,
            expenseShares,
            settlements,
            receipts,
            receiptItems,
            activityLogs,
            guestSplits,
            systemSettings,
            systemInvites,
            adminAuditLogs,
          },
        };

        await tx.adminAuditLog.create({
          data: {
            adminId: session.user.id,
            action: 'EXPORT_CREATED',
            metadata: { tableCount: Object.keys(exportData.data).length },
          },
        });
        return exportData;
      },
      { timeout: 30_000 },
    );

    const json = JSON.stringify(exportData, null, 2);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    return new Response(json, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="billok-export-${timestamp}.json"`,
      },
    });
  } catch (error) {
    if (error instanceof AppError) return new Response('Доступ запрещён', { status: 403 });
    console.error('Export failed:', error instanceof Error ? error.name : 'unknown');
    return new Response('Внутренняя ошибка сервера', { status: 500 });
  }
}
