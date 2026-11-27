'use client';

import { ReceiptTitleHeading } from '@/components/receipt-title-editor';

import { use, useState } from 'react';
import { ReceiptTabs, type ReceiptTab } from '@/components/receipt-tabs';
import { useLocale, useTranslations } from 'next-intl';
import { trpc } from '@/lib/trpc';
import { formatCents } from '@/lib/money';
import { copyToClipboard } from '@/lib/clipboard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Copy, Share2, Receipt, ArrowRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { getInitials } from '@/lib/avatar';
import { guestVisualColorStyle, guestVisualColorBorder } from '@/lib/guest-visual-color';
import { guestReceiptRoleFlags } from '@/lib/guest-receipt-roles';
import { GuestReceiptRoles } from '@/components/guest-receipt-roles';
import { GuestAccountStatus } from '@/components/guest-account-status';
import { ReceiptLinkExpiry } from '@/components/receipt-link-expiry';
import { groupSizeWeights, personItemShares } from '@/lib/split-calculator';

export default function SharedSplitPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [tab, setTab] = useState<ReceiptTab>('items');
  const locale = useLocale();
  const t = useTranslations('split.result');
  const tl = useTranslations('split.claim');
  const tr = useTranslations('split.roles');
  const ta = useTranslations('split.accountStatus');
  const tc = useTranslations('common');
  const split = trpc.guest.getSplit.useQuery(
    { token },
    {
      refetchInterval: (query) => (query.state.error?.data?.httpStatus === 404 ? false : 12000),
      refetchOnWindowFocus: 'always',
    },
  );
  if (split.isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">{t('loading')}</p>
      </div>
    );
  }

  if (split.error && (!split.data || split.error.data?.httpStatus === 404)) {
    return (
      <div className="text-center space-y-6 py-20">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <Receipt className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-bold">{t('notFound')}</h2>
          <p className="text-muted-foreground">
            {/* The server's key for an expired split (guest.getSplit); its message is in the page's language */}
            {split.error.data?.messageKey === 'splitExpired' ? t('expiredMessage') : t('invalidMessage')}
          </p>
        </div>
        <Button nativeButton={false} render={<Link href="/split" />}>
          <ArrowRight className="mr-2 h-4 w-4" />
          {t('splitYourOwn')}
        </Button>
      </div>
    );
  }

  const data = split.data!;
  const roleMarks = (index: number) => (
    <GuestReceiptRoles
      {...guestReceiptRoleFlags(index, data.organizerIndex, data.paidByIndex, data.people.length)}
      creatorLabel={tr('creator')}
      payerLabel={tr('payer')}
    />
  );
  const accountMark = (index: number) => (
    <GuestAccountStatus
      isRegistered={data.people[index]?.isRegistered === true}
      registeredLabel={ta('registered')}
      guestLabel={ta('guest')}
    />
  );
  const expiredCreatorHistory = data.archivedCreatorView;
  const currency = data.receiptData.currency;
  // Saved shares are the definitive settlement, including personal tips.
  const finalizedTotal = data.summary.reduce((sum, person) => sum + person.total, 0);
  const personalTipTotal = data.summary.reduce((sum, person) => sum + person.tip, 0) - data.receiptData.tip;
  const paidBy = data.people[data.paidByIndex]?.name ?? t('someone');
  // Weighted the way the totals were, so each person's lines add up to their total
  const weights = groupSizeWeights(data.people);

  async function handleShare() {
    const url = window.location.origin + window.location.pathname;
    const text = t('shareText', {
      merchant: data.receiptData.merchantName ?? t('aReceipt'),
      total: formatCents(finalizedTotal, currency, locale),
    });

    if (navigator.share) {
      try {
        await navigator.share({ title: t('billSplit'), text, url });
      } catch {
        // User cancelled
      }
    } else if (await copyToClipboard(url)) {
      toast.success(t('linkCopied'));
    } else {
      toast.error(tc('actions.copyFailed'));
    }
  }

  async function handleCopy() {
    if (await copyToClipboard(window.location.origin + window.location.pathname)) {
      toast.success(t('linkCopied'));
    } else {
      toast.error(tc('actions.copyFailed'));
    }
  }

  const initials = getInitials;

  return (
    <div className="min-w-0 space-y-6 pb-[calc(1rem+env(safe-area-inset-bottom))]" data-testid="split-result">
      {/* Keep the private-claim return action ahead of long breakdowns. The
          sticky header and footer can fully cover a link near page bottom
          when the visible Android viewport is only 380 CSS px tall. */}
      {/* Return to the participant's private settlement view. The shared
          summary contains no personal payment controls or identity token. */}
      <Link
        href={expiredCreatorHistory ? '/splits' : '/split/' + token + '/claim'}
        className="flex min-h-11 w-full min-w-0 scroll-mt-20 items-center justify-center rounded-lg border px-4 py-2 text-center text-sm font-medium text-primary [overflow-wrap:anywhere] hover:bg-muted"
        data-testid="split-result-back-to-claim"
      >
        {expiredCreatorHistory ? t('backToHistory') : 'Вернуться к своему чеку'}
      </Link>

      {/* Header */}
      <div className="text-center space-y-1 pt-4">
        <ReceiptTitleHeading
          id={data.id}
          title={data.receiptData.merchantName ?? t('billSplit')}
          canRename={data.canRename}
        />
        {data.receiptData.date && <p className="text-sm text-muted-foreground">{data.receiptData.date}</p>}
        <p className="text-sm text-muted-foreground">
          {t.rich('paidBy', {
            payer: paidBy,
            name: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
          })}
        </p>
      </div>

      {!expiredCreatorHistory && (
        <ReceiptTabs
          activeTab={tab}
          onSelect={setTab}
          peopleCount={data.people.length}
          itemCount={data.items.length}
          finalized
        />
      )}
      <section
        id="claim-items-panel"
        role="tabpanel"
        aria-labelledby={expiredCreatorHistory ? undefined : 'claim-items-tab'}
        hidden={!expiredCreatorHistory && tab !== 'items'}
        className="min-w-0 space-y-6"
      >
        {/* Total */}
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="py-4">
            <div className="flex justify-between items-center">
              <span className="font-semibold text-lg">{t('totalBill')}</span>
              <span className="text-2xl font-bold text-primary">
                <span data-testid="split-result-total">{formatCents(finalizedTotal, currency, locale)}</span>
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Per-person breakdown */}
        <div className="space-y-3">
          <h3 className="font-semibold text-base">{t('eachPersonOwes')}</h3>
          {data.summary.map((person, idx) => {
            // The items this person is on, each at their share of its price
            const personItems = personItemShares(person.personIndex, {
              items: data.items,
              assignments: data.assignments,
              balanceAcrossItems: data.receiptData.roundingBalanced === true,
              organizerIndex: data.organizerIndex,
              ...weights,
            });

            return (
              <Card
                key={idx}
                className="border-l-4"
                style={{ borderLeftColor: guestVisualColorBorder(data.people[person.personIndex], person.personIndex) }}
                data-testid={`person-card-${idx}`}
              >
                <CardContent className="py-4">
                  <div className="mb-3 min-w-0 space-y-2" data-testid={'result-person-layout-' + person.personIndex}>
                    <div className="flex min-w-0 items-start gap-3">
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarFallback
                          className="text-sm font-semibold"
                          style={guestVisualColorStyle(data.people[person.personIndex], person.personIndex)}
                        >
                          {initials(person.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1 space-y-1">
                        <span
                          className="block min-w-0 font-semibold [overflow-wrap:anywhere]"
                          data-testid={'result-person-name-' + person.personIndex}
                        >
                          {person.name}
                        </span>
                        <div
                          className="flex min-w-0 flex-wrap items-center gap-1"
                          data-testid={'result-person-badges-' + person.personIndex}
                        >
                          {roleMarks(person.personIndex)}
                          {accountMark(person.personIndex)}
                        </div>
                      </div>
                    </div>
                    <div className="flex min-w-0 justify-end border-t pt-2">
                      <span
                        className="max-w-full text-xl font-bold text-primary tabular-nums [overflow-wrap:anywhere]"
                        data-testid={`person-total-${idx}`}
                      >
                        {formatCents(person.total, currency, locale)}
                      </span>
                    </div>
                  </div>

                  {/* Item details */}
                  <div className="space-y-1 text-sm text-muted-foreground">
                    {personItems.map(({ itemIndex, amount, share }, i) => {
                      const item = data.items[itemIndex]!;
                      return (
                        <div key={i} className="flex justify-between gap-2">
                          <span>
                            {item.name}
                            {share.numerator < share.denominator && (
                              <span className="text-xs">
                                {' '}
                                {t('shareOf', {
                                  fraction: `${share.numerator}/${share.denominator}`,
                                  price: formatCents(item.totalPrice, currency, locale),
                                })}
                              </span>
                            )}
                          </span>
                          <span data-testid="line-amount">{formatCents(amount, currency, locale)}</span>
                        </div>
                      );
                    })}
                    {!!person.roundingCorrectionCents && (
                      <div
                        className="flex min-w-0 flex-wrap justify-between gap-2"
                        data-testid={'guest-result-rounding-correction-' + person.personIndex}
                      >
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                          {t('organizerRoundingCorrection')}
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {formatCents(person.roundingCorrectionCents, currency, locale)}
                        </span>
                      </div>
                    )}
                    {person.tax > 0 && (
                      <div className="flex justify-between">
                        <span>{t('tax')}</span>
                        <span data-testid="line-amount">{formatCents(person.tax, currency, locale)}</span>
                      </div>
                    )}
                    {person.tip > 0 && (
                      <div className="flex justify-between">
                        <span>{t('tip')}</span>
                        <span data-testid="line-amount">{formatCents(person.tip, currency, locale)}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Receipt breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t('receiptDetails')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">
                {currency === 'RUB' && data.receiptData.tax === 0 ? t('dishesTotal') : t('subtotal')}
              </span>
              <span data-testid="split-result-food-total">
                {formatCents(data.receiptData.subtotal, currency, locale)}
              </span>
            </div>
            {/* Historical receipts may contain upstream charges. New BillOK receipts
              use tax=0 and tip=0 until each person can choose their own tip. */}
            {data.receiptData.tax > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('tax')}</span>
                <span>{formatCents(data.receiptData.tax, currency, locale)}</span>
              </div>
            )}
            {data.receiptData.tip > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('tip')}</span>
                <span>{formatCents(data.receiptData.tip, currency, locale)}</span>
              </div>
            )}
            {currency === 'RUB' && data.receiptData.tax === 0 && data.receiptData.tip === 0 ? (
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('tipForWaiter')}</span>
                <span data-testid="split-result-personal-tips">{formatCents(personalTipTotal, currency, locale)}</span>
              </div>
            ) : (
              personalTipTotal > 0 && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{t('tip')}</span>
                  <span data-testid="split-result-personal-tips">
                    {formatCents(personalTipTotal, currency, locale)}
                  </span>
                </div>
              )
            )}
            <Separator />
            <div className="flex justify-between gap-2 font-semibold">
              <span>
                {currency === 'RUB' && data.receiptData.tax === 0 && data.receiptData.tip === 0
                  ? t('totalWithTips')
                  : t('total')}
              </span>
              <span>{formatCents(finalizedTotal, currency, locale)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Expiry notice */}
        <ReceiptLinkExpiry expiresAt={data.expiresAt} archived={expiredCreatorHistory} />

        {/* CTA */}
        <div className="text-center">
          <Link href="/split" className="text-sm font-medium text-primary hover:underline">
            {t('splitYourOwn')}
          </Link>
          <span className="text-muted-foreground mx-2">{t('or')}</span>
          <Link href="/register" className="text-sm font-medium text-primary hover:underline">
            {t('createAccount')}
          </Link>
        </div>
      </section>
      {!expiredCreatorHistory && (
        <section
          id="claim-links-panel"
          role="tabpanel"
          aria-labelledby="claim-links-tab"
          hidden={tab !== 'links'}
          className="min-w-0"
          data-testid="split-result-actions"
        >
          <h3 className="mb-3 font-semibold">{tl('commonLinkTitle')}</h3>
          <div className="mx-auto flex max-w-lg min-w-0 gap-2 max-[399px]:flex-col">
            <Button
              variant="outline"
              className="min-h-14 min-w-0 w-full flex-1 whitespace-normal text-center leading-tight"
              onClick={handleCopy}
              data-testid="copy-link-btn"
            >
              <Copy className="mr-2 h-5 w-5" />
              {t('copyLink')}
            </Button>
            <Button
              className="min-h-14 min-w-0 w-full flex-1 whitespace-normal text-center leading-tight"
              onClick={handleShare}
              data-testid="share-btn"
            >
              <Share2 className="mr-2 h-5 w-5" />
              {t('share')}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
