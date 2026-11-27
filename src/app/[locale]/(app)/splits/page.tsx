'use client';

import { useState } from 'react';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Scissors, Receipt, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { localizedTrpcError } from '@/lib/localized-trpc-error';
import { useTranslations, useLocale } from 'next-intl';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ReceiptTitleEditor } from '@/components/receipt-title-editor';

export default function SplitsPage() {
  const t = useTranslations('splits');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = trpc.guest.mySplits.useInfiniteQuery(
    { limit: 20 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      initialCursor: undefined,
      refetchInterval: 12000,
      refetchOnWindowFocus: 'always',
    },
  );

  const utils = trpc.useUtils();
  const deleteSplit = trpc.guest.deleteSplit.useMutation({
    onSuccess: () => {
      utils.guest.mySplits.invalidate();
      toast.success(t('deleted'));
    },
    onError: (err) => toast.error(localizedTrpcError(err, tc('errors.generic'))),
  });

  const splits = data?.pages.flatMap((page) => page.splits) ?? [];

  return (
    <div className="space-y-6" data-testid="splits-page">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{data?.pages[0]?.owner ? t('allTitle') : t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button className="min-h-11" nativeButton={false} render={<Link href="/split" />}>
          <Receipt className="mr-2 h-4 w-4" />
          {t('goToSplit')}
        </Button>
      </div>

      {isLoading && <p className="text-muted-foreground">{t('loading')}</p>}

      {!isLoading && splits.length === 0 && (
        <Card data-testid="splits-empty">
          <CardContent className="py-12 text-center">
            <Scissors className="mx-auto h-10 w-10 text-muted-foreground/50" />
            <p className="mt-3 text-muted-foreground">{t('empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('emptyDescription')}</p>
            <Button nativeButton={false} className="mt-4 min-h-11" render={<Link href="/split" />}>
              <Receipt className="mr-2 h-4 w-4" />
              {t('goToSplit')}
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4">
        {splits.map((split) => (
          <Card
            key={split.id}
            className="relative border-l-[3px] border-l-primary/60 transition-all duration-200 hover:-translate-y-px hover:border-l-primary hover:shadow-md"
            data-testid={`split-card-${split.id}`}
          >
            <CardHeader className="min-w-0 pb-2">
              <div className="flex min-w-0 items-start gap-1">
                <CardTitle className="flex min-w-0 flex-1 items-start gap-2 text-base">
                  <Scissors className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                  {split.shareToken ? (
                    <Link
                      className="min-w-0 flex-1 [overflow-wrap:anywhere] after:absolute after:inset-0"
                      href={
                        split.status === 'FINALIZED' && !split.canOpenClaim
                          ? `/split/${split.shareToken}`
                          : `/split/${split.shareToken}/claim`
                      }
                    >
                      {split.merchantName ?? t('untitled')}
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      {split.merchantName ?? t('untitled')}
                    </span>
                  )}
                </CardTitle>
                {split.canRename && <ReceiptTitleEditor id={split.id} title={split.merchantName ?? t('untitled')} />}
                {split.canDelete && (
                  <button
                    type="button"
                    onClick={() => setDeleteId(split.id)}
                    className="relative z-10 flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    aria-label={t('delete')}
                    data-testid={`delete-split-${split.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="min-w-0">
                <Badge
                  variant={split.status === 'FINALIZED' ? 'default' : 'outline'}
                  className="max-w-full whitespace-normal text-[10px]"
                >
                  {split.status === 'FINALIZED' ? t('finalized') : t('claiming')}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {split.total != null && (
                <p className="mb-1.5 text-lg font-semibold tabular-nums [overflow-wrap:anywhere]">
                  {formatCents(split.total, split.currency, locale)}
                </p>
              )}
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-1 text-sm text-muted-foreground">
                <span>
                  {t('people', { count: split.peopleCount })}
                  {' · '}
                  {t('items', { count: split.itemCount })}
                </span>
                <span>{new Date(split.createdAt).toLocaleDateString(locale)}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {hasNextPage && (
        <div className="text-center">
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {t('loadMore')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={t('deleteTitle')}
        description={t('deleteDescription')}
        confirmLabel={tc('actions.delete')}
        onConfirm={() => deleteId && deleteSplit.mutate({ id: deleteId })}
      />
    </div>
  );
}
