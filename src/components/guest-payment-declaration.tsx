'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { becameVerified } from '@/lib/guest-payment-notifications';
import { Button } from '@/components/ui/button';

/** The payer confirms receipt separately. This button records only the debtor's own declaration. */
export function GuestPaymentDeclaration({
  token,
  personId,
  personToken,
}: {
  token: string;
  personId: string;
  personToken: string;
}) {
  const t = useTranslations('split.claim');
  const read = trpc.guest.getMyPaymentDeclaration.useMutation();
  const mark = trpc.guest.markMyPayment.useMutation();
  const [declaredAt, setDeclaredAt] = useState<string | null>(null);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const lastVerified = useRef<string | null | undefined>(undefined);
  const readStatus = read.mutateAsync;

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void readStatus({ token, personId, personToken })
        .then((data) => {
          if (cancelled) return;
          if (becameVerified(lastVerified.current, data.verifiedAt)) {
            toast.success(t('paymentVerifiedNotice'), {
              id: 'billok-verified-' + token + '-' + personId + '-' + data.verifiedAt,
            });
          }
          lastVerified.current = data.verifiedAt ?? lastVerified.current ?? null;
          // Never roll the visible payment state back on an older poll result.
          setDeclaredAt((previous) => data.declaredPaidAt ?? previous);
          setVerifiedAt((previous) => data.verifiedAt ?? previous);
          setLoaded(true);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    refresh();
    const interval = setInterval(refresh, 12000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [readStatus, token, personId, personToken, t]);

  async function declarePayment() {
    if (!loaded || declaredAt || mark.isPending) return;
    try {
      const result = await mark.mutateAsync({ token, personId, personToken });
      setDeclaredAt(result.declaredPaidAt);
      toast.success(t('paymentDeclared'));
    } catch {
      toast.error(t('paymentDeclarationFailed'));
    }
  }
  if (!loaded)
    return (
      <p className="text-xs text-muted-foreground" data-testid="guest-payment-declaration-loading">
        {failed ? t('paymentDeclarationLoadFailed') : t('paymentDeclarationLoading')}
      </p>
    );
  return (
    <div className="space-y-2" data-testid="guest-payment-declaration">
      {declaredAt ? (
        <>
          <p className="text-sm font-semibold" data-testid="guest-payment-declared">
            {t('paymentDeclared')}
          </p>
          <p
            className="text-xs text-muted-foreground"
            data-testid={verifiedAt ? 'guest-payment-verified' : 'guest-payment-awaiting'}
          >
            {verifiedAt ? t('payerPaymentVerified') : t('paymentAwaitingVerification')}
          </p>
        </>
      ) : (
        <>
          <Button
            type="button"
            className="min-h-11 w-full"
            onClick={declarePayment}
            disabled={mark.isPending}
            data-testid="guest-mark-paid"
          >
            {t('markMyPayment')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('paymentDeclarationDisclaimer')}</p>
        </>
      )}
    </div>
  );
}
