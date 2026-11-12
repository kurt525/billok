import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { requireOwner } from '@/server/lib/owner-access';
import { logAdminAction } from '@/server/trpc/routers/admin';

export async function GET() {
  // Owner privileges are bound to the immutable DB user ID, not email.
  const session = await auth();
  if (!session?.user?.id) return new Response('Forbidden', { status: 403 });
  try {
    await requireOwner(db, session.user.id);
  } catch {
    return new Response('Forbidden', { status: 403 });
  }

  try {
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
      db.user.findMany({
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
      db.group.findMany(),
      db.groupMember.findMany(),
      db.groupInvite.findMany(),
      db.expense.findMany(),
      db.expenseShare.findMany(),
      db.settlement.findMany(),
      db.receipt.findMany({
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
      db.receiptItem.findMany(),
      db.activityLog.findMany(),
      db.guestSplit.findMany(),
      db.systemSetting.findMany(),
      db.systemInvite.findMany(),
      db.adminAuditLog.findMany(),
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

    // Log the export action
    await logAdminAction(db, session.user.id!, 'EXPORT_CREATED', null, {
      tableCount: Object.keys(exportData.data).length,
    });

    const json = JSON.stringify(exportData, null, 2);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    return new Response(json, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="billok-export-${timestamp}.json"`,
      },
    });
  } catch (error) {
    console.error('Export failed:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}
