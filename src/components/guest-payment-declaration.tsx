'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { shouldNotifyGuestReceiptConfirmation } from '@/lib/guest-payment-notifications';
import { formatCents } from '@/lib/money';
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
  const locale = useLocale();
  const read = trpc.guest.getMyPaymentDeclaration.useMutation();
  const mark = trpc.guest.markMyPayment.useMutation();
  const unmark = trpc.guest.unmarkMyPayment.useMutation();
  const [declaredAt, setDeclaredAt] = useState<string | null>(null);
  const [declaredAmountCents, setDeclaredAmountCents] = useState<number | null>(null);
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
          if (shouldNotifyGuestReceiptConfirmation(lastVerified.current, data.verifiedAt, canDeclare)) {
            const notice = data.confirmationNotice;
            toast.success(
              notice
                ? t('paymentVerifiedNoticeDetailed', {
                    payer: notice.payerName,
                    amount: formatCents(notice.amountCents, 'RUB', locale),
                    receipt: notice.receiptName,
                  })
                : t('paymentVerifiedNotice'),
              {
                id: 'billok-verified-' + token + '-' + personId + '-' + data.verifiedAt,
                duration: 20_000,
                ...(notice
                  ? {
                      description: (
                        <div className="flex min-w-0 flex-col gap-1 break-words">
                          <time dateTime={notice.confirmedAt} data-testid="guest-payment-confirmation-time">
                            {new Date(notice.confirmedAt).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US')}
                          </time>
                          <a
                            href={notice.receiptHref}
                            className="font-semibold underline underline-offset-2"
                            data-testid="guest-payment-confirmation-link"
                          >
                            {t('paymentVerifiedNoticeOpenReceipt')}
                          </a>
                        </div>
                      ),
                    }
                  : {}),
              },
            );
          }
          lastVerified.current = data.verifiedAt;
          // A current server snapshot may legitimately clear a declaration; stale reads are ignored above.
          setDeclaredAt(data.declaredPaidAt);
          setDeclaredAmountCents(data.declaredAmountCents);
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
  }, [readStatus, token, personId, personToken, canDeclare, locale, t]);

  // 5.9: the recipient's manual attestation triggers an invalidation; the
  // participant's personal token fetches only their own confirmation state.
  // SSE carries no identifying details and cannot replace the private read.
  // Finalized receipt pages do not run the pre-finalization claim SSE channel.
  useEffect(() => {
    // Never race a first-load private status read against the SSE ready hint.
    // During repeated mobile reloads the ready hint could supersede that
    // initial response and leave the payment action stuck in loading.
    if (!loaded || typeof EventSource === 'undefined') return;
    const url = '/api/guest/' + encodeURIComponent(token) + '/events';
    const controller = new AbortController();
    let closed = false;
    let attempts = 0;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let renewTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => refreshCurrent.current();
    const retry = () => {
      if (closed || controller.signal.aborted) return;
      source?.close();
      source = null;
      if (retryTimer) clearTimeout(retryTimer);
      if (renewTimer) clearTimeout(renewTimer);
      renewTimer = null;
      retryTimer = setTimeout(() => void connect(), Math.min(30_000, 2000 * 2 ** Math.min(attempts++, 4)));
    };
    const connect = async () => {
      if (closed || controller.signal.aborted) return;
      try {
        const ticket = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ personId, personToken }),
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!ticket.ok) return retry();
        if (closed || controller.signal.aborted) return;
        source?.close();
        const next = new EventSource(url);
        source = next;
        next.addEventListener('ready', () => {
          if (closed) return;
          attempts = 0;
          refresh();
          if (renewTimer) clearTimeout(renewTimer);
          renewTimer = setTimeout(() => {
            next.close();
            void connect();
          }, 4 * 60_000);
        });
        next.addEventListener('changed', refresh);
        next.onerror = retry;
      } catch {
        retry();
      }
    };
    void connect();
    return () => {
      closed = true;
      controller.abort();
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
      if (renewTimer) clearTimeout(renewTimer);
    };
  }, [loaded, token, personId, personToken]);

  async function declarePayment() {
    if (!canDeclare || !loaded || declaredAt || verifiedAt || writeInFlight.current) return;
    writeInFlight.current = true;
    latestRead.current += 1;
    try {
      const result = await mark.mutateAsync({ token, personId, personToken });
      setDeclaredAt(result.declaredPaidAt);
      setDeclaredAmountCents(result.declaredAmountCents);
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
      setDeclaredAmountCents(null);
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
  const exactDeclaredAmount =
    declaredAmountCents !== null ? formatCents(declaredAmountCents, 'RUB', locale) : amountLabel;
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
              {t('paymentDeclaredAmount', { amount: exactDeclaredAmount })}
            </p>
          )}
        </>
      ) : declaredAt ? (
        <>
          <p className="text-sm font-semibold text-green-700 dark:text-green-400" data-testid="guest-payment-declared">
            {t('paymentDeclared')}
          </p>
          <p className="break-words text-sm tabular-nums" data-testid="guest-payment-declared-amount">
            {t('paymentDeclaredAmount', { amount: exactDeclaredAmount })}
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
