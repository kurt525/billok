'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { formatCents } from '@/lib/money';
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
  const readPayments = read.mutateAsync;

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      // Always read a fresh snapshot using the payer's personal token.
      void readPayments({ token, personId, personToken })
        .then((result) => {
          if (cancelled) return;
          // Declarations and verifications are irreversible. A poll started
          // before an action must not overwrite a newer confirmed status.
          setPayments((current) =>
            result.payments.map((entry) => {
              const previous = current?.find((item) => item.personId === entry.personId);
              return {
                ...entry,
                declaredPaidAt: entry.declaredPaidAt ?? previous?.declaredPaidAt ?? null,
                verifiedAt: entry.verifiedAt ?? previous?.verifiedAt ?? null,
              };
            }),
          );
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
  }, [readPayments, token, personId, personToken]);

  async function confirmReceipt(debtorId: string) {
    if (verifyingId || !payments?.some((p) => p.personId === debtorId && p.declaredPaidAt && !p.verifiedAt)) return;
    setVerifyingId(debtorId);
    try {
      const result = await verify.mutateAsync({ token, personId, personToken, debtorId });
      setPayments(
        (current) =>
          current?.map((entry) =>
            entry.personId === debtorId ? { ...entry, verifiedAt: result.verifiedAt } : entry,
          ) ?? null,
      );
      toast.success(t('payerPaymentVerifiedToast'));
    } catch {
      toast.error(t('payerPaymentVerifyFailed'));
    } finally {
      setVerifyingId(null);
    }
  }

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
        {!payments ? (
          <p className="text-sm text-muted-foreground">{t('payerPaymentReviewLoading')}</p>
        ) : payments.length === 0 ? (
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
