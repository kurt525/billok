'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { formatCents } from '@/lib/money';
import { mergeGuestPaymentStatuses, newlyDeclaredGuestPayments } from '@/lib/guest-payment-notifications';
import { getDocumentActiveMountRegistry } from '@/lib/latest-active-mount';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type PaymentRow = {
  personId: string;
  name: string;
  amount: number;
  declaredPaidAt: string | null;
  verifiedAt: string | null;
};

// One review per payer, even across different hydrated client module copies.
const inactiveOnServer = () => false;

/** Shows the payer only the receipt's outstanding, declared and verified transfers.
 * The data is never included in guest.getSession or the public receipt link.
 */
export function GuestPayerPaymentReview({
  token,
  personId,
  personToken,
}: {
  token: string;
  personId: string;
  personToken: string;
}) {
  const t = useTranslations('split.claim');
  const locale = useLocale();
  const read = trpc.guest.getMyPayerPaymentReview.useMutation();
  const verify = trpc.guest.confirmGuestPaymentReceived.useMutation();
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const latestPayments = useRef<PaymentRow[] | null>(null);
  const readPayments = read.mutateAsync;
  const activePayerReviews = getDocumentActiveMountRegistry();
  const [mountId] = useState(() => Symbol('payer-review'));
  const activeReviewKey = [token, personId, personToken].join(':');
  const subscribeToActiveReview = useCallback(
    (onChange: () => void) => activePayerReviews.subscribe(activeReviewKey, mountId, onChange),
    [activePayerReviews, activeReviewKey, mountId],
  );
  const getActiveReviewSnapshot = useCallback(
    () => activePayerReviews.isActive(activeReviewKey, mountId),
    [activePayerReviews, activeReviewKey, mountId],
  );
  const isActiveReview = useSyncExternalStore(subscribeToActiveReview, getActiveReviewSnapshot, inactiveOnServer);

  useEffect(() => {
    if (!isActiveReview) return;
    let cancelled = false;
    const refresh = () => {
      // Always read a fresh snapshot using the payer's personal token.
      void readPayments({ token, personId, personToken })
        .then((result) => {
          if (cancelled) return;
          const merged = mergeGuestPaymentStatuses(latestPayments.current, result.payments);
          const newlyDeclared = newlyDeclaredGuestPayments(latestPayments.current, merged);
          latestPayments.current = merged;
          setPayments(merged);
          // One stable Sonner ID per private event: a temporary second route
          // observer must not display the same event twice.
          if (newlyDeclared.length > 0) {
            const noticeId =
              'billok-declared-' +
              token +
              '-' +
              newlyDeclared
                .map((row) => row.personId + ':' + row.declaredPaidAt)
                .sort()
                .join(',');
            if (newlyDeclared.length === 1) {
              toast.info(t('payerPaymentDeclarationNotice', { name: newlyDeclared[0]!.name }), { id: noticeId });
            } else {
              toast.info(t('payerPaymentDeclarationBatchNotice', { count: newlyDeclared.length }), { id: noticeId });
            }
          }
          setLoadFailed(false);
        })
        .catch(() => {
          if (!cancelled) setLoadFailed(true);
        });
    };
    refresh();
    const interval = setInterval(refresh, 12000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isActiveReview, readPayments, token, personId, personToken, t]);

  async function confirmReceipt(debtorId: string) {
    if (verifyingId || !payments?.some((p) => p.personId === debtorId && p.declaredPaidAt && !p.verifiedAt)) return;
    setVerifyingId(debtorId);
    try {
      const result = await verify.mutateAsync({ token, personId, personToken, debtorId });
      const updated =
        latestPayments.current?.map((entry) =>
          entry.personId === debtorId ? { ...entry, verifiedAt: result.verifiedAt } : entry,
        ) ?? null;
      latestPayments.current = updated;
      setPayments(updated);
      toast.success(t('payerPaymentVerifiedToast'));
    } catch {
      toast.error(t('payerPaymentVerifyFailed'));
    } finally {
      setVerifyingId(null);
    }
  }

  // Do not server-render an empty review card. On hydration a stale loading
  // card could remain beside the freshly populated card in the DOM.
  // Mount the review card only after its private data has been loaded.
  if (!isActiveReview || (payments === null && !loadFailed)) return null;

  return (
    <Card data-testid="guest-payer-payment-review">
      <CardContent className="space-y-3 py-4">
        <h3 className="font-semibold">{t('payerPaymentReviewTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('payerPaymentReviewHint')}</p>
        {loadFailed && (
          <p className="text-xs text-destructive" data-testid="guest-payer-review-error">
            {t('payerPaymentReviewError')}
          </p>
        )}
        {!payments ? null : payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('payerPaymentReviewNone')}</p>
        ) : (
          <div className="space-y-3">
            {payments.map((payment) => (
              <div
                key={payment.personId}
                className="space-y-2 rounded-lg border p-3"
                data-testid={'guest-payer-payment-' + payment.personId}
              >
                <div className="flex min-w-0 justify-between gap-3 text-sm">
                  <span className="min-w-0 [overflow-wrap:anywhere] font-medium">{payment.name}</span>
                  <span className="shrink-0 font-semibold tabular-nums">
                    {formatCents(payment.amount, 'RUB', locale)}
                  </span>
                </div>
                <p
                  className="text-xs text-muted-foreground"
                  data-testid={'guest-payer-payment-status-' + payment.personId}
                >
                  {payment.verifiedAt
                    ? t('payerPaymentVerified')
                    : payment.declaredPaidAt
                      ? t('payerPaymentDeclared')
                      : t('payerPaymentNotDeclared')}
                </p>
                {payment.declaredPaidAt && !payment.verifiedAt && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full"
                    disabled={verifyingId !== null}
                    onClick={() => {
                      void confirmReceipt(payment.personId);
                    }}
                    data-testid={'guest-payer-verify-' + payment.personId}
                  >
                    {t('payerPaymentVerifyAction')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
