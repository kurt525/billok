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
  canDeclare = true,
  amountLabel,
}: {
  token: string;
  personId: string;
  personToken: string;
  canDeclare?: boolean;
  /** Exact finalized receipt/group amount, formatted by the receipt page. */
  amountLabel: string;
}) {
  const t = useTranslations('split.claim');
  const read = trpc.guest.getMyPaymentDeclaration.useMutation();
  const mark = trpc.guest.markMyPayment.useMutation();
  const unmark = trpc.guest.unmarkMyPayment.useMutation();
  const [declaredAt, setDeclaredAt] = useState<string | null>(null);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const lastVerified = useRef<string | null | undefined>(undefined);
  const latestRead = useRef(0);
  const writeInFlight = useRef(false);
  const refreshCurrent = useRef<() => void>(() => {});
  const readStatus = read.mutateAsync;

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (writeInFlight.current) return;
      const readId = ++latestRead.current;
      void readStatus({ token, personId, personToken })
        .then((data) => {
          if (cancelled || writeInFlight.current || readId !== latestRead.current) return;
          if (becameVerified(lastVerified.current, data.verifiedAt)) {
            toast.success(t('paymentVerifiedNotice'), {
              id: 'billok-verified-' + token + '-' + personId + '-' + data.verifiedAt,
            });
          }
          lastVerified.current = data.verifiedAt;
          // A current server snapshot may legitimately clear a declaration; stale reads are ignored above.
          setDeclaredAt(data.declaredPaidAt);
          setVerifiedAt(data.verifiedAt);
          setLoaded(true);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled && !writeInFlight.current && readId === latestRead.current) setFailed(true);
        });
    };
    refreshCurrent.current = refresh;
    refresh();
    const interval = setInterval(refresh, 12000);
    // Refresh promptly when another tab/device changed the persisted payment state.
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    const refreshOnVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', refreshOnVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refreshOnVisible);
      refreshCurrent.current = () => {};
    };
  }, [readStatus, token, personId, personToken, t]);

  async function declarePayment() {
    if (!canDeclare || !loaded || declaredAt || verifiedAt || writeInFlight.current) return;
    writeInFlight.current = true;
    latestRead.current += 1;
    try {
      const result = await mark.mutateAsync({ token, personId, personToken });
      setDeclaredAt(result.declaredPaidAt);
      toast.success(t('paymentDeclared'));
    } catch {
      toast.error(t('paymentDeclarationFailed'));
    } finally {
      writeInFlight.current = false;
      refreshCurrent.current();
    }
  }

  async function cancelDeclaration() {
    if (!canDeclare || !loaded || !declaredAt || verifiedAt || writeInFlight.current) return;
    writeInFlight.current = true;
    latestRead.current += 1;
    try {
      await unmark.mutateAsync({ token, personId, personToken });
      setDeclaredAt(null);
      setVerifiedAt(null);
      lastVerified.current = null;
      toast.success(t('paymentUnmarked'));
    } catch {
      // A payer may have verified this payment while cancellation was in flight.
      toast.error(t('paymentUnmarkFailed'));
    } finally {
      writeInFlight.current = false;
      refreshCurrent.current();
    }
  }
  if (!loaded)
    return (
      <p className="text-xs text-muted-foreground" data-testid="guest-payment-declaration-loading">
        {failed ? t('paymentDeclarationLoadFailed') : t('paymentDeclarationLoading')}
      </p>
    );
  return (
    <div className="space-y-2" aria-live="polite" data-testid="guest-payment-declaration">
      {verifiedAt ? (
        <>
          <p className="text-sm font-semibold text-green-700 dark:text-green-400" data-testid="guest-payment-verified">
            {t('paymentVerifiedByRecipient')}
          </p>
          {declaredAt && (
            <p className="break-words text-sm tabular-nums" data-testid="guest-payment-declared-amount">
              {t('paymentDeclaredAmount', { amount: amountLabel })}
            </p>
          )}
        </>
      ) : declaredAt ? (
        <>
          <p className="text-sm font-semibold text-green-700 dark:text-green-400" data-testid="guest-payment-declared">
            {t('paymentDeclared')}
          </p>
          <p className="break-words text-sm tabular-nums" data-testid="guest-payment-declared-amount">
            {t('paymentDeclaredAmount', { amount: amountLabel })}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="guest-payment-awaiting">
            {t('paymentAwaitingRecipient')}
          </p>
          {canDeclare && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full min-w-0 whitespace-normal [overflow-wrap:anywhere]"
              onClick={cancelDeclaration}
              disabled={unmark.isPending || mark.isPending}
              data-testid="guest-unmark-paid"
            >
              {t('paymentUnmarkAction')}
            </Button>
          )}
        </>
      ) : canDeclare ? (
        <>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full min-w-0 whitespace-normal border-red-300 text-center text-red-700 [overflow-wrap:anywhere] hover:text-red-800 dark:border-red-800 dark:text-red-400 dark:hover:text-red-300"
            onClick={declarePayment}
            disabled={mark.isPending}
            data-testid="guest-mark-paid"
          >
            {t('markMyPayment')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('paymentDeclarationDisclaimer')}</p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="guest-group-payment-readonly">
          {t('paymentGroupStatusOnly')}
        </p>
      )}
    </div>
  );
}
