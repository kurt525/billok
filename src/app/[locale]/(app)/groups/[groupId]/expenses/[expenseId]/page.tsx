'use client';

import { use, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { manualExpenseBreakdown } from '@/lib/manual-expense-breakdown';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, Trash2, Pencil } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { toast } from 'sonner';
import { localizedTrpcError } from '@/lib/localized-trpc-error';
import { ConfirmDialog } from '@/components/confirm-dialog';

export default function ExpenseDetailPage({ params }: { params: Promise<{ groupId: string; expenseId: string }> }) {
  const { groupId, expenseId } = use(params);
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations('expenses');
  const tc = useTranslations('common');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const expense = trpc.expenses.get.useQuery({ groupId, expenseId });
  // The original positions and recorded personal tips remain on the receipt.
  // Non-receipt expenses incur no extra fetch or tip display.
  const receiptItems = trpc.receipts.getReceiptItems.useQuery(
    { receiptId: expense.data?.receiptId ?? '' },
    { enabled: !!expense.data?.receiptId },
  );
  const group = trpc.groups.get.useQuery({ groupId });
  const deleteExpense = trpc.expenses.delete.useMutation({
    onSuccess: () => router.push(`/groups/${groupId}`),
    onError: (err) => toast.error(localizedTrpcError(err, tc('errors.generic'))),
  });

  if (expense.isLoading) return <LoadingSpinner />;
  if (!expense.data) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <Trash2 className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h2 className="mb-2 text-lg font-semibold">{t('detail.notFound')}</h2>
        <p className="mb-4 text-sm text-muted-foreground">{t('detail.notFoundDescription')}</p>
        <Button nativeButton={false} render={<Link href={`/groups/${groupId}`} />}>
          {t('detail.backToGroup')}
        </Button>
      </div>
    );
  }

  const e = expense.data;
  const splitModeLabels = {
    EQUAL: t('new.splitEqual'),
    EXACT: t('new.splitExact'),
    PERCENTAGE: t('new.splitPercentage'),
    SHARES: t('new.splitShares'),
    ITEM: t('detail.splitByItem'),
  } satisfies Record<typeof e.splitMode, string>;
  const groupCurrency = group.data?.currency ?? 'RUB';
  const isCurrencyConverted = e.baseCurrencyAmount != null && e.currency.toUpperCase() !== groupCurrency.toUpperCase();
  const manualSummary =
    receiptItems.data?.receipt.isManual && e.receiptId === receiptItems.data.receipt.id
      ? manualExpenseBreakdown({
          receipt: receiptItems.data.receipt,
          items: receiptItems.data.items,
          expense: e,
        })
      : null;

  return (
    <div className="mx-auto w-full min-w-0 max-w-lg space-y-6">
      <div className="flex min-w-0 items-start gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          data-testid="expense-detail-back"
          aria-label={t('detail.backToGroup')}
          nativeButton={false}
          render={<Link href={`/groups/${groupId}`} />}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="min-w-0 flex-1 text-2xl font-bold [overflow-wrap:anywhere]">{e.title}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 max-w-full flex-1 basis-40 [overflow-wrap:anywhere]">
              <span data-testid="expense-detail-total" className="tabular-nums [overflow-wrap:anywhere]">
                {formatCents(e.amount, e.currency, locale)}
              </span>
              {isCurrencyConverted && (
                <span className="ml-2 text-sm font-normal text-muted-foreground [overflow-wrap:anywhere]">
                  ({formatCents(e.baseCurrencyAmount!, groupCurrency, locale)})
                </span>
              )}
            </div>
            <Badge variant="secondary" className="max-w-full whitespace-normal [overflow-wrap:anywhere]">
              {splitModeLabels[e.splitMode]}
            </Badge>
          </CardTitle>
          {isCurrencyConverted && (
            <p className="text-xs text-muted-foreground">
              {t('detail.exchangeRate', {
                rate: e.exchangeRate?.toFixed(4) ?? '1.0000',
                from: e.currency,
                to: groupCurrency,
              })}
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid min-w-0 grid-cols-1 gap-4 text-sm min-[360px]:grid-cols-2">
            <div className="min-w-0">
              <p className="text-muted-foreground">{t('detail.paidBy')}</p>
              <p data-testid="expense-detail-payer" className="min-w-0 font-medium [overflow-wrap:anywhere]">
                {e.paidBy.name ?? t('detail.unknown')}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground">{t('detail.date')}</p>
              <p className="min-w-0 font-medium [overflow-wrap:anywhere]">
                {new Date(e.expenseDate).toLocaleDateString(locale)}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-muted-foreground">{t('detail.addedBy')}</p>
              <p className="min-w-0 font-medium [overflow-wrap:anywhere]">{e.addedBy.name ?? t('detail.unknown')}</p>
            </div>
          </div>

          {e.description && (
            <>
              <Separator />
              <p className="min-w-0 text-sm [overflow-wrap:anywhere]">{e.description}</p>
            </>
          )}

          {receiptItems.data && receiptItems.data.items.length > 0 && (
            <>
              <Separator />
              <div className="min-w-0 space-y-2 text-sm" data-testid="group-finalized-receipt-items">
                <p className="font-semibold">{t('detail.splitByItem')}</p>
                {receiptItems.data.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1"
                    data-testid="group-finalized-receipt-item"
                  >
                    <div className="min-w-0 flex-1 basis-24">
                      <p
                        className="min-w-0 font-medium [overflow-wrap:anywhere]"
                        data-testid="group-finalized-item-name"
                      >
                        {item.name}
                      </p>
                      <p className="text-muted-foreground">{item.quantity} ×</p>
                    </div>
                    <span
                      className="ml-auto min-w-0 max-w-full text-right font-medium tabular-nums [overflow-wrap:anywhere]"
                      data-testid="group-finalized-item-total"
                    >
                      {formatCents(item.totalPrice, e.currency, locale)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {manualSummary && (
            <>
              <Separator />
              <div className="space-y-2 text-sm" data-testid="manual-group-payer-summary">
                <p className="font-semibold">{t('detail.waiterTipSummary')}</p>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 basis-24 text-muted-foreground [overflow-wrap:anywhere]">
                    {t('detail.dishesTotal')}
                  </span>
                  <span
                    className="ml-auto min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]"
                    data-testid="group-finalized-food-total"
                  >
                    {formatCents(manualSummary.foodTotal, 'RUB', locale)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 basis-24 text-muted-foreground [overflow-wrap:anywhere]">
                    {t('detail.tipForWaiter')}
                  </span>
                  <span
                    className="ml-auto min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]"
                    data-testid="group-finalized-tip-total"
                  >
                    {formatCents(manualSummary.tipTotal, 'RUB', locale)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 font-semibold">
                  <span className="min-w-0 flex-1 basis-24 [overflow-wrap:anywhere]">{t('detail.totalWithTips')}</span>
                  <span
                    className="ml-auto min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]"
                    data-testid="group-finalized-grand-total"
                  >
                    {formatCents(manualSummary.total, 'RUB', locale)}
                  </span>
                </div>
                <Separator />
                <p className="font-medium">{t('detail.initialReimbursements')}</p>
                <p className="text-xs text-muted-foreground">{t('detail.initialReimbursementsHint')}</p>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 basis-24 text-muted-foreground [overflow-wrap:anywhere]">
                    {t('detail.payerOwnShare')}
                  </span>
                  <span
                    className="ml-auto min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]"
                    data-testid="group-payer-own-share"
                  >
                    {formatCents(manualSummary.payerShare, 'RUB', locale)}
                  </span>
                </div>
                {manualSummary.reimbursements.map((reimbursement) => {
                  const member = e.shares.find((share) => share.userId === reimbursement.fromId);
                  return (
                    <div
                      key={reimbursement.fromId}
                      className="flex min-w-0 flex-wrap items-start justify-between gap-3"
                      data-testid={'group-payer-reimbursement-' + reimbursement.fromId}
                    >
                      <span className="min-w-0 flex-1 basis-24 [overflow-wrap:anywhere]">
                        {t('detail.memberReimburses', { name: member?.user.name ?? t('detail.unknown') })}
                      </span>
                      <span className="ml-auto min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]">
                        {formatCents(reimbursement.amount, 'RUB', locale)}
                      </span>
                    </div>
                  );
                })}
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 font-semibold">
                  <span className="min-w-0 flex-1 basis-24 [overflow-wrap:anywhere]">
                    {t('detail.reimbursementsTotal')}
                  </span>
                  <span
                    className="ml-auto min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]"
                    data-testid="group-payer-reimbursements-total"
                  >
                    {formatCents(manualSummary.reimbursementTotal, 'RUB', locale)}
                  </span>
                </div>
              </div>
            </>
          )}

          <Separator />

          <div>
            <p className="mb-2 text-sm font-medium text-muted-foreground">{t('detail.split')}</p>
            <div className="space-y-1">
              {e.shares.map((share) => (
                <div
                  key={share.userId}
                  className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1 text-sm"
                >
                  <span className="min-w-0 flex-1 basis-24 [overflow-wrap:anywhere]">
                    {share.user.name ?? t('detail.unknown')}
                  </span>
                  <span className="ml-auto min-w-0 max-w-full text-right font-medium tabular-nums [overflow-wrap:anywhere]">
                    {formatCents(share.amount, e.currency, locale)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* An archived group refuses edits and deletes, so offer them only once the group is known to be active */}
      {group.data?.archivedAt && <p className="text-center text-sm text-muted-foreground">{t('detail.archived')}</p>}
      {group.data && !group.data.archivedAt && (
        <div className="flex min-w-0 flex-wrap gap-2">
          <Button
            variant="outline"
            data-testid="expense-detail-edit"
            className="min-h-11 min-w-0 flex-1 basis-32 whitespace-normal text-center [overflow-wrap:anywhere]"
            nativeButton={false}
            render={<Link href={`/groups/${groupId}/expenses/${expenseId}/edit`} />}
          >
            <Pencil className="mr-2 h-4 w-4" />
            {t('detail.edit')}
          </Button>
          <Button
            variant="destructive"
            data-testid="expense-detail-delete"
            className="min-h-11 min-w-0 flex-1 basis-32 whitespace-normal text-center [overflow-wrap:anywhere]"
            onClick={() => setConfirmDelete(true)}
            disabled={deleteExpense.isPending}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {deleteExpense.isPending ? t('detail.deleting') : t('detail.delete')}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('detail.deleteTitle')}
        description={t('detail.deleteDescription', { title: e.title })}
        confirmLabel={t('detail.delete')}
        onConfirm={() => deleteExpense.mutate({ groupId, expenseId })}
      />
    </div>
  );
}
