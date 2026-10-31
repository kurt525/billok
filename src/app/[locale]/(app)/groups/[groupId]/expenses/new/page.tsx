'use client';

import { use, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { parseToCents } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { EqualSplit } from '@/components/expenses/equal-split';
import { ExactSplit } from '@/components/expenses/exact-split';
import { PercentageSplit } from '@/components/expenses/percentage-split';
import { SharesSplit } from '@/components/expenses/shares-split';
import { ArchivedGroupNotice } from '@/components/groups/archived-group-notice';
import { localizedTrpcError } from '@/lib/localized-trpc-error';

type SplitMode = 'EQUAL' | 'EXACT' | 'PERCENTAGE' | 'SHARES';

type MemberInfo = {
  id: string;
  name: string | null;
};

type ShareEntry = {
  userId: string;
  amount: number;
  shares?: number;
  percentage?: number;
};

export default function NewExpensePage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = use(params);
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('expenses');
  const tc = useTranslations('common');
  const group = trpc.groups.get.useQuery({ groupId });
  // Who tRPC acts as: the impersonated user while an admin impersonates, where
  // useSession() would still report the admin.
  const profile = trpc.auth.getProfile.useQuery();

  const [title, setTitle] = useState('');
  const [amountStr, setAmountStr] = useState('');
  const [category, setCategory] = useState('');
  const [paidById, setPaidById] = useState('');
  const [splitMode, setSplitMode] = useState<SplitMode>('EQUAL');
  const [shares, setShares] = useState<ShareEntry[]>([]);
  // Existing non-RUB groups must keep their historical amounts unchanged.
  // Until a safe migration is defined, new entries into such groups are blocked,
  // rather than silently converting or mixing currencies.
  const groupCurrency = group.data?.currency ?? 'RUB';
  const isRubGroup = group.data?.currency?.toUpperCase() === 'RUB';

  const splitModes = useMemo(
    () => [
      { value: 'EQUAL' as SplitMode, label: t('new.splitEqual'), description: t('new.splitEqualDescription') },
      { value: 'EXACT' as SplitMode, label: t('new.splitExact'), description: t('new.splitExactDescription') },
      {
        value: 'PERCENTAGE' as SplitMode,
        label: t('new.splitPercentage'),
        description: t('new.splitPercentageDescription'),
      },
      { value: 'SHARES' as SplitMode, label: t('new.splitShares'), description: t('new.splitSharesDescription') },
    ],
    [t],
  );

  const createManualReceipt = trpc.receipts.createManual.useMutation({
    onSuccess: ({ receiptId }) => router.push('/groups/' + groupId + '/scan?receiptId=' + receiptId),
  });
  const createExpense = trpc.expenses.create.useMutation({
    onSuccess: () => {
      router.push(`/groups/${groupId}`);
    },
  });

  const members: MemberInfo[] = useMemo(
    () =>
      group.data?.members.map((m) => ({
        id: m.user.id,
        name: m.user.name ?? m.user.email,
      })) ?? [],
    [group.data?.members],
  );

  // Until someone picks a payer, default to the current user (when they're in the group).
  const currentUserId = profile.data?.id;
  const defaultPaidById = currentUserId && members.some((m) => m.id === currentUserId) ? currentUserId : '';
  const effectivePaidById = paidById || defaultPaidById;

  const amountCents = parseToCents(amountStr);
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isRubGroup || !effectivePaidById || amountCents <= 0 || shares.length === 0) return;

    createExpense.mutate({
      groupId,
      title,
      amount: amountCents,
      currency: 'RUB',
      category: category || undefined,
      paidById: effectivePaidById,
      splitMode,
      shares,
    });
  }

  if (group.isLoading) return <LoadingSpinner />;
  if (group.data?.archivedAt) return <ArchivedGroupNotice groupId={groupId} />;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('new.backToGroup')}
          nativeButton={false}
          render={<Link href={`/groups/${groupId}`} />}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-bold">{t('new.title')}</h1>
      </div>

      {!isRubGroup && group.data && (
        <p
          role="alert"
          data-testid="rub-only-legacy-warning"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          {t('new.rubOnlyLegacyGroup', { currency: groupCurrency })}
        </p>
      )}

      <Card data-testid="manual-group-receipt-entry">
        <CardHeader>
          <CardTitle>{t('new.manualReceiptTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('new.manualReceiptDescription')}</p>
          <Button
            type="button"
            className="min-h-12 w-full"
            onClick={() => createManualReceipt.mutate({ groupId })}
            disabled={createManualReceipt.isPending || !isRubGroup}
            data-testid="create-manual-group-receipt"
          >
            {createManualReceipt.isPending ? t('new.creatingManualReceipt') : t('new.createManualReceipt')}
          </Button>
          {createManualReceipt.error && (
            <p role="alert" className="text-sm text-destructive">
              {localizedTrpcError(createManualReceipt.error, tc('errors.generic'))}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('new.expenseDetails')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">{t('new.description')}</Label>
              <Input
                id="title"
                placeholder={t('new.descriptionPlaceholder')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="amount">{t('new.amount')} (₽)</Label>
              <Input
                id="amount"
                type="text"
                inputMode="decimal"
                min="0.01"
                placeholder={t('new.amountPlaceholder')}
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                required
                className="h-11 min-w-0 text-base"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">{t('new.category')}</Label>
              <Input
                id="category"
                placeholder={t('new.categoryPlaceholder')}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="paidBy">{t('new.paidBy')}</Label>
              <select
                id="paidBy"
                data-testid="paid-by-select"
                value={effectivePaidById}
                onChange={(e) => setPaidById(e.target.value)}
                required
                className="flex h-11 min-w-0 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">{t('new.selectMember')}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? t('new.unnamed')}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label>{t('new.splitType')}</Label>
              <div className="grid grid-cols-2 gap-2">
                {splitModes.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setSplitMode(mode.value)}
                    data-testid={`expense-split-mode-${mode.value}`}
                    className={`min-h-11 min-w-0 rounded-md border p-2 text-left text-sm transition-colors ${
                      splitMode === mode.value ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'
                    }`}
                  >
                    <div className="font-medium">{mode.label}</div>
                    <div className="text-xs text-muted-foreground">{mode.description}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t('new.splitBetween')}</Label>
              {splitMode === 'EQUAL' && (
                <EqualSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency="RUB"
                />
              )}
              {splitMode === 'EXACT' && (
                <ExactSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency="RUB"
                />
              )}
              {splitMode === 'PERCENTAGE' && (
                <PercentageSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency="RUB"
                />
              )}
              {splitMode === 'SHARES' && (
                <SharesSplit
                  members={members}
                  totalCents={amountCents}
                  onChange={setShares}
                  locale={locale}
                  currency="RUB"
                />
              )}
            </div>

            {createExpense.error && (
              <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {localizedTrpcError(createExpense.error, tc('errors.generic'))}
              </div>
            )}

            <Button
              type="submit"
              className="min-h-11 w-full text-base"
              disabled={!isRubGroup || createExpense.isPending || amountCents <= 0 || shares.length === 0}
            >
              {createExpense.isPending ? t('new.submitting') : t('new.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
