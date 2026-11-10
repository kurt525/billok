'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { shouldNotifyGuestReceiptConfirmation } from '@/lib/guest-payment-notifications';
import { formatCents } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { GuestWebPushControls } from '@/components/guest-web-push-controls';

type ReceiptCancellationNotification = {
  id: string;
  payerName: string;
  amountCents: number;
  receiptName: string;
  cancelledAt: string;
  receiptHref: string;
  readAt: string | null;
};

type ReceiptConfirmationNotification = {
  id: string;
  payerName: string;
  amountCents: number;
  receiptName: string;
  confirmedAt: string;
  receiptHref: string;
  readAt: string | null;
};

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
  const markNotificationRead = trpc.guest.markMyPaymentNotificationRead.useMutation();
  const [receiptNotification, setReceiptNotification] = useState<ReceiptConfirmationNotification | null>(null);
  const [cancellationNotifications, setCancellationNotifications] = useState<ReceiptCancellationNotification[]>([]);
  const [declaredAt, setDeclaredAt] = useState<string | null>(null);
  const [declaredAmountCents, setDeclaredAmountCents] = useState<number | null>(null);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const lastVerified = useRef<string | null | undefined>(undefined);
  const lastCancellationId = useRef<string | null | undefined>(undefined);
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
          // First read establishes a baseline. Only newly committed, personal
          // cancellation events make a toast; repeated polls and reloads don't.
          const newestCancellation = data.cancellationNotifications?.at(-1) ?? null;
          if (
            canDeclare &&
            lastCancellationId.current !== undefined &&
            newestCancellation &&
            newestCancellation.id !== lastCancellationId.current
          ) {
            toast.warning(
              t('paymentCancelNoticeDetailed', {
                payer: newestCancellation.payerName,
                amount: formatCents(newestCancellation.amountCents, 'RUB', locale),
                receipt: newestCancellation.receiptName,
              }),
              {
                id: 'billok-cancel-' + token + '-' + personId + '-' + newestCancellation.id,
                duration: 20_000,
              },
            );
          }
          lastCancellationId.current = newestCancellation?.id ?? null;
          lastVerified.current = data.verifiedAt;
          // A current server snapshot may legitimately clear a declaration; stale reads are ignored above.
          setDeclaredAt(data.declaredPaidAt);
          setDeclaredAmountCents(data.declaredAmountCents);
          setVerifiedAt(data.verifiedAt);
          setReceiptNotification(data.notification ?? null);
          setCancellationNotifications(data.cancellationNotifications ?? []);
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
      const result = await mark.mutateAsync({
        token,
        personId,
        personToken,
        requestId: window.crypto.randomUUID(),
      });
      setDeclaredAt(result.declaredPaidAt);
      setDeclaredAmountCents(result.declaredAmountCents);
      // A concurrent payer verification may commit first. Do not falsely
      // claim the participant added another declaration afterward.
      toast.success(result.declaredPaidAt ? t('paymentDeclared') : t('paymentVerifiedByRecipient'));
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
      const result = await unmark.mutateAsync({
        token,
        personId,
        personToken,
        requestId: window.crypto.randomUUID(),
      });
      // A delayed retry from a previous click must not make the client show
      // a revoked state after a newer declaration or payer confirmation.
      setDeclaredAt(result.declaredPaidAt);
      setVerifiedAt(result.verifiedAt);
      if (!result.declaredPaidAt) setDeclaredAmountCents(null);
      if (!result.verifiedAt) lastVerified.current = null;
      if (!result.declaredPaidAt && !result.verifiedAt) toast.success(t('paymentUnmarked'));
    } catch {
      // A payer may have verified this payment while cancellation was in flight.
      toast.error(t('paymentUnmarkFailed'));
    } finally {
      writeInFlight.current = false;
      refreshCurrent.current();
    }
  }
  async function markReceiptNotificationRead(notificationId: string) {
    if (!canDeclare || markNotificationRead.isPending) return;
    const record =
      receiptNotification?.id === notificationId
        ? receiptNotification
        : cancellationNotifications.find((entry) => entry.id === notificationId);
    if (!record || record.readAt) return;
    latestRead.current += 1;
    try {
      const result = await markNotificationRead.mutateAsync({ token, personId, personToken, notificationId });
      setReceiptNotification((current) =>
        current?.id === notificationId ? { ...current, readAt: result.readAt } : current,
      );
      setCancellationNotifications((current) =>
        current.map((entry) => (entry.id === notificationId ? { ...entry, readAt: result.readAt } : entry)),
      );
    } catch {
      toast.error(t('paymentNotificationReadFailed'));
    } finally {
      refreshCurrent.current();
    }
  }

  const unreadCount =
    (receiptNotification && !receiptNotification.readAt ? 1 : 0) +
    cancellationNotifications.filter((entry) => !entry.readAt).length;
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
      {(receiptNotification || cancellationNotifications.length > 0) && canDeclare && (
        <section
          className="min-w-0 space-y-2 rounded-lg border border-border p-3"
          aria-label={t('paymentNotificationsTitle')}
          data-testid="guest-payment-notifications"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{t('paymentNotificationsTitle')}</h3>
            {unreadCount > 0 && (
              <span
                className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
                data-testid="guest-payment-unread-count"
              >
                {t('paymentNotificationUnreadCount', { count: unreadCount })}
              </span>
            )}
          </div>
          <ul className="min-w-0 space-y-2">
            {[...cancellationNotifications].reverse().map((entry) => (
              <li
                key={entry.id}
                data-testid={'guest-payment-cancellation-' + entry.id}
                className={
                  'min-w-0 space-y-2 rounded-md p-3 [overflow-wrap:anywhere] ' +
                  (entry.readAt ? 'bg-muted/40' : 'border border-amber-600/40 bg-amber-50 dark:bg-amber-950/20')
                }
              >
                <p className="text-xs font-semibold" data-testid="guest-payment-cancellation-status">
                  {entry.readAt ? t('paymentNotificationRead') : t('paymentNotificationUnread')}
                </p>
                <p className="text-sm" data-testid="guest-payment-cancellation-text">
                  {t('paymentCancelNoticeDetailed', {
                    payer: entry.payerName,
                    amount: formatCents(entry.amountCents, 'RUB', locale),
                    receipt: entry.receiptName,
                  })}
                </p>
                <time className="block text-xs text-muted-foreground" dateTime={entry.cancelledAt}>
                  {new Date(entry.cancelledAt).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US')}
                </time>
                <a
                  href={entry.receiptHref}
                  className="inline-block min-h-11 py-3 text-sm font-semibold underline underline-offset-2"
                >
                  {t('paymentVerifiedNoticeOpenReceipt')}
                </a>
                {!entry.readAt && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full whitespace-normal"
                    disabled={markNotificationRead.isPending}
                    onClick={() => {
                      void markReceiptNotificationRead(entry.id);
                    }}
                    data-testid="guest-payment-cancellation-mark-read"
                  >
                    {t('paymentNotificationMarkRead')}
                  </Button>
                )}
              </li>
            ))}
            {receiptNotification && (
              <li
                data-testid={'guest-payment-notification-' + receiptNotification.id}
                className={
                  'min-w-0 space-y-2 rounded-md p-3 [overflow-wrap:anywhere] ' +
                  (receiptNotification.readAt ? 'bg-muted/40' : 'border border-primary/40 bg-primary/5')
                }
              >
                <p className="text-xs font-semibold" data-testid="guest-payment-notification-status">
                  {receiptNotification.readAt ? t('paymentNotificationRead') : t('paymentNotificationUnread')}
                </p>
                <p className="text-sm" data-testid="guest-payment-notification-text">
                  {t('paymentVerifiedNoticeDetailed', {
                    payer: receiptNotification.payerName,
                    amount: formatCents(receiptNotification.amountCents, 'RUB', locale),
                    receipt: receiptNotification.receiptName,
                  })}
                </p>
                <time
                  className="block text-xs text-muted-foreground"
                  dateTime={receiptNotification.confirmedAt}
                  data-testid="guest-payment-notification-time"
                >
                  {new Date(receiptNotification.confirmedAt).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US')}
                </time>
                <a
                  href={receiptNotification.receiptHref}
                  className="inline-block min-h-11 py-3 text-sm font-semibold underline underline-offset-2"
                  data-testid="guest-payment-notification-link"
                >
                  {t('paymentVerifiedNoticeOpenReceipt')}
                </a>
                {!receiptNotification.readAt && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full whitespace-normal"
                    disabled={markNotificationRead.isPending}
                    onClick={() => {
                      void markReceiptNotificationRead(receiptNotification.id);
                    }}
                    data-testid="guest-payment-notification-mark-read"
                  >
                    {t('paymentNotificationMarkRead')}
                  </Button>
                )}
              </li>
            )}
          </ul>
        </section>
      )}
      {canDeclare && <GuestWebPushControls token={token} personId={personId} personToken={personToken} />}
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
          <p
            className="min-w-0 rounded-md border border-amber-600/40 bg-amber-50 p-3 text-xs text-amber-900 [overflow-wrap:anywhere] dark:bg-amber-950/20 dark:text-amber-200"
            role="status"
            data-testid="guest-payment-not-bank-confirmed"
          >
            {t('paymentAwaitingVerification')}
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
