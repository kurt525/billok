'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ArrowRight, Handshake, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { localizedTrpcError } from '@/lib/localized-trpc-error';

type PendingDelete = { id: string; from: string; to: string; amount: string; date: string };

/**
 * Payments recorded with Settle up, newest first. The payer, or a group
 * owner/admin, can delete a mistaken one (#261). Renders nothing until the
 * group has a payment.
 */
export function PaymentsList({
  groupId,
  groupCurrency,
  currentUserId,
  isOwnerOrAdmin,
  archived,
}: {
  groupId: string;
  groupCurrency: string;
  currentUserId: string | undefined;
  isOwnerOrAdmin: boolean;
  archived: boolean;
}) {
  const t = useTranslations('groups');
  const tc = useTranslations('common');
  const locale = useLocale();
  const utils = trpc.useUtils();
  const [pending, setPending] = useState<PendingDelete | null>(null);

  const payments = trpc.settlements.list.useInfiniteQuery(
    { groupId, limit: 10 },
    { getNextPageParam: (lastPage) => lastPage.nextCursor, initialCursor: undefined },
  );

  const remove = trpc.settlements.delete.useMutation({
    onSuccess: () => {
      toast.success(t('payments.deleted'));
      setPending(null);
      void utils.settlements.list.invalidate({ groupId });
      void utils.balances.getGroupBalances.invalidate({ groupId });
      void utils.balances.getSimplifiedDebts.invalidate({ groupId });
      void utils.balances.getDashboard.invalidate();
    },
    onError: (err) => toast.error(localizedTrpcError(err, tc('errors.generic'))),
  });

  const items = payments.data?.pages.flatMap((page) => page.items) ?? [];
  if (items.length === 0) return null;

  return (
    <div data-testid="payments-section">
      <h2 className="mb-4 text-lg font-semibold">{t('payments.title')}</h2>
      <Card className="divide-y divide-border overflow-hidden">
        {items.map((p, index) => {
          const from = p.from.name ?? p.from.email ?? t('detail.unknown');
          const to = p.to.name ?? p.to.email ?? t('detail.unknown');
          // Same rule as the expense list: a payment in the group's currency has no base amount
          const amount = formatCents(p.amount, p.baseCurrencyAmount != null ? p.currency : groupCurrency, locale);
          const date = new Date(p.settledAt).toLocaleDateString(locale);
          const canDelete = !archived && (isOwnerOrAdmin || p.fromId === currentUserId);
          return (
            <div
              key={p.id}
              className={`flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3 ${index % 2 === 1 ? 'bg-muted/20' : ''}`}
              data-testid="payment-row"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent">
                  <Handshake className="h-3.5 w-3.5 text-accent-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{from}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{to}</span>
                  </p>
                  <p className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {date}
                    {p.note && ` · ${p.note}`}
                  </p>
                </div>
              </div>
              <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
                <p className="min-w-0 max-w-full text-right text-lg font-semibold tabular-nums [overflow-wrap:anywhere]">
                  {amount}
                </p>
                {canDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('payments.deleteLabel', { from, to, amount })}
                    onClick={() => setPending({ id: p.id, from, to, amount, date })}
                    data-testid="delete-payment"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </Card>
      {payments.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 min-h-11"
          disabled={payments.isFetchingNextPage}
          onClick={() => void payments.fetchNextPage()}
        >
          {t('payments.showMore')}
        </Button>
      )}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto overscroll-contain pb-[calc(1rem+env(safe-area-inset-bottom))] [overflow-wrap:anywhere]"
          data-testid="mobile-payment-delete-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t('payments.deleteTitle')}</DialogTitle>
            {pending && (
              <DialogDescription>
                {t('payments.deleteDescription', {
                  from: pending.from,
                  to: pending.to,
                  amount: pending.amount,
                  date: pending.date,
                })}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter className="flex min-w-0 flex-wrap gap-2">
            <Button variant="outline" className="min-h-11 min-w-11" onClick={() => setPending(null)}>
              {tc('actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="min-h-11 min-w-11"
              disabled={remove.isPending}
              onClick={() => pending && remove.mutate({ groupId, settlementId: pending.id })}
              data-testid="confirm-delete-payment"
            >
              {remove.isPending ? t('payments.deleting') : tc('actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
