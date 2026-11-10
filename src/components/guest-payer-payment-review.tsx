'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { formatCents } from '@/lib/money';
import { groupGuestPayerPayments, type GuestPayerPaymentGroup } from '@/lib/guest-payer-payment-groups';
import { summarizeGuestPayerPaymentGroups } from '@/lib/guest-payer-payment-summary';
import {
  mergeGuestPaymentStatuses,
  newlyDeclaredGuestPayments,
  newlyRevokedGuestPayments,
} from '@/lib/guest-payment-notifications';
import { getDocumentActiveMountRegistry } from '@/lib/latest-active-mount';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

type PaymentRow = {
  personId: string;
  name: string;
  amount: number;
  declaredPaidAt: string | null;
  unmarkedAt?: string;
  verifiedAt: string | null;
  verifiedByPersonId: string | null;
  memberIds?: string[];
  members?: { personId: string; personIndex: number; amountCents: number; tipCents: number }[];
};

/** Shows the payer only the receipt's outstanding, declared and verified transfers.
 * The data is never included in guest.getSession or the public receipt link.
 */
export function GuestPayerPaymentReview({
  token,
  personId,
  personToken,
  people,
}: {
  token: string;
  personId: string;
  personToken: string;
  people?: { id: string; name: string }[];
}) {
  const t = useTranslations('split.claim');
  const locale = useLocale();
  const read = trpc.guest.getMyPayerPaymentReview.useMutation();
  const verify = trpc.guest.confirmGuestPaymentReceived.useMutation();
  const cancelVerified = trpc.guest.cancelGuestPaymentReceived.useMutation();
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const latestPayments = useRef<PaymentRow[] | null>(null);
  const latestRead = useRef(0);
  const writeInFlight = useRef(false);
  const refreshCurrent = useRef<() => void>(() => {});
  const readPayments = read.mutateAsync;
  const activePayerReviews = getDocumentActiveMountRegistry();
  const [mountId] = useState(() => Symbol('payer-review'));
  // Never subscribe/update an external store during React hydration. The
  // private card starts absent in both server HTML and the first client render;
  // ownership is acquired in an effect after React commits the component.
  const [isActiveReview, setIsActiveReview] = useState(false);
  useEffect(() => {
    let mounted = true;
    const onOwnershipChanged = () => {
      if (mounted) setIsActiveReview(activePayerReviews.isActive(token, mountId));
    };
    // Each receipt has exactly one payer, including if an older Next.js route
    // remains mounted. The shared document registry transfers ownership.
    const unsubscribe = activePayerReviews.subscribe(token, mountId, onOwnershipChanged);
    onOwnershipChanged();
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [activePayerReviews, token, mountId]);

  useEffect(() => {
    if (!isActiveReview) return;
    let cancelled = false;
    const refresh = () => {
      if (writeInFlight.current) return;
      const readId = ++latestRead.current;
      // Always read a fresh snapshot using the payer's personal token.
      void readPayments({ token, personId, personToken })
        .then((result) => {
          if (cancelled || writeInFlight.current || readId !== latestRead.current) return;
          const merged = mergeGuestPaymentStatuses(latestPayments.current, result.payments);
          const newlyDeclared = newlyDeclaredGuestPayments(latestPayments.current, merged);
          const newlyRevoked = newlyRevokedGuestPayments(latestPayments.current, merged);
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
              const payment = newlyDeclared[0]!;
              toast.info(
                t('payerPaymentDeclarationNotice', {
                  name: payment.name,
                  amount: formatCents(payment.amount, 'RUB', locale),
                }),
                { id: noticeId },
              );
            } else {
              toast.info(t('payerPaymentDeclarationBatchNotice', { count: newlyDeclared.length }), { id: noticeId });
            }
          }
          // The cancelled declaration is not a bank reversal. A separate
          // addressed notice is shown only to this receipt's actual payer.
          // Compare server event IDs/timestamps, not the current payment
          // bucket, so a fast re-declaration cannot silently hide a reversal.
          for (const payment of newlyRevoked) {
            toast.warning(
              t('payerPaymentDeclarationRevokedNotice', {
                name: payment.name,
                amount: formatCents(payment.amount, 'RUB', locale),
              }),
              { id: 'billok-unmarked-' + token + '-' + payment.personId + '-' + payment.unmarkedAt },
            );
          }
          setLoadFailed(false);
        })
        .catch(() => {
          if (!cancelled && !writeInFlight.current && readId === latestRead.current) setLoadFailed(true);
        });
    };
    refreshCurrent.current = refresh;
    refresh();
    // The private SSE subscription normally refreshes the payer within the
    // receipt's change window. Also read immediately after a phone reconnects
    // or returns from the background instead of waiting for the 12s fallback.
    const interval = setInterval(refresh, 12000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      refreshCurrent.current = () => {};
    };
  }, [isActiveReview, readPayments, token, personId, personToken, t, locale]);

  // 5.5: receive receipt-scoped change hints promptly, but fetch the actual
  // amounts only through the payer's existing private tRPC procedure.
  // SSE has no personal data; the short-lived authorization ticket is issued
  // over POST with the payer's secret in the body, never the EventSource URL.
  useEffect(() => {
    if (!isActiveReview || typeof EventSource === 'undefined') return;
    const url = '/api/guest/' + encodeURIComponent(token) + '/events';
    const controller = new AbortController();
    let closed = false;
    let retryCount = 0;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let renewTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => refreshCurrent.current();
    const retry = () => {
      if (closed || controller.signal.aborted) return;
      source?.close();
      source = null;
      if (renewTimer) clearTimeout(renewTimer);
      if (retryTimer) clearTimeout(retryTimer);
      renewTimer = null;
      retryTimer = setTimeout(() => void connect(), Math.min(30_000, 2000 * 2 ** Math.min(retryCount++, 4)));
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
        const events = new EventSource(url);
        source = events;
        events.addEventListener('ready', () => {
          if (closed) return;
          retryCount = 0;
          refresh();
          if (renewTimer) clearTimeout(renewTimer);
          renewTimer = setTimeout(() => {
            events.close();
            void connect();
          }, 4 * 60_000);
        });
        events.addEventListener('changed', refresh);
        events.onerror = retry;
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
  }, [isActiveReview, token, personId, personToken]);

  async function confirmReceipt(debtorId: string) {
    if (verifyingId || writeInFlight.current || !payments?.some((p) => p.personId === debtorId && !p.verifiedAt))
      return;
    writeInFlight.current = true;
    latestRead.current += 1;
    setVerifyingId(debtorId);
    try {
      const result = await verify.mutateAsync({
        token,
        personId,
        personToken,
        debtorId,
        requestId: window.crypto.randomUUID(),
      });
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
      writeInFlight.current = false;
      setVerifyingId(null);
      refreshCurrent.current();
    }
  }

  async function cancelReceipt(debtorId: string) {
    if (
      verifyingId ||
      writeInFlight.current ||
      !payments?.some((payment) => payment.personId === debtorId && payment.verifiedAt) ||
      !window.confirm(t('payerPaymentCancelConfirm'))
    )
      return;
    writeInFlight.current = true;
    latestRead.current += 1;
    setVerifyingId(debtorId);
    try {
      await cancelVerified.mutateAsync({
        token,
        personId,
        personToken,
        debtorId,
        requestId: window.crypto.randomUUID(),
      });
      const updated =
        latestPayments.current?.map((entry) =>
          entry.personId === debtorId ? { ...entry, verifiedAt: null, verifiedByPersonId: null } : entry,
        ) ?? null;
      latestPayments.current = updated;
      setPayments(updated);
      toast.success(t('payerPaymentCancelToast'));
    } catch {
      toast.error(t('payerPaymentCancelFailed'));
    } finally {
      writeInFlight.current = false;
      setVerifyingId(null);
      refreshCurrent.current();
    }
  }

  const paymentGroups = groupGuestPayerPayments(payments ?? [], personId);
  const paymentSummary = summarizeGuestPayerPaymentGroups(paymentGroups);
  const groupLabels: Record<GuestPayerPaymentGroup, string> = {
    verified: t('payerPaymentGroupVerified'),
    awaiting: t('payerPaymentGroupAwaiting'),
    unpaid: t('payerPaymentGroupUnpaid'),
  };
  const statusOrder: GuestPayerPaymentGroup[] = ['verified', 'awaiting', 'unpaid'];

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
        {!payments ? null : (
          <div className="space-y-3" data-testid="guest-payer-payment-groups">
            {paymentSummary ? (
              <dl
                className="min-w-0 space-y-2 rounded-lg border p-3 text-sm"
                data-testid="guest-payer-payment-summary"
                aria-live="polite"
              >
                {(
                  [
                    ['total', 'payerSummaryTotal', paymentSummary.total],
                    ['verified', 'payerSummaryVerified', paymentSummary.verified],
                    ['awaiting', 'payerSummaryAwaiting', paymentSummary.awaiting],
                    ['unpaid', 'payerSummaryUnpaid', paymentSummary.unpaid],
                    ['outstanding', 'payerSummaryOutstanding', paymentSummary.outstanding],
                  ] as const
                ).map(([key, label, amount]) => (
                  <div key={key} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <dt className="min-w-0 [overflow-wrap:anywhere]">{t(label)}</dt>
                    <dd
                      className="min-w-0 max-w-full font-semibold tabular-nums [overflow-wrap:anywhere]"
                      data-testid={'guest-payer-summary-' + key}
                    >
                      {formatCents(amount, 'RUB', locale)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-destructive" data-testid="guest-payer-summary-invalid">
                {t('payerSummaryUnavailable')}
              </p>
            )}
            {payments.length === 0 && <p className="text-sm text-muted-foreground">{t('payerPaymentReviewNone')}</p>}
            {statusOrder.map((status) => (
              <details
                key={status}
                className="min-w-0 rounded-lg border"
                open
                data-testid={'guest-payer-group-' + status}
              >
                <summary className="min-h-11 min-w-0 cursor-pointer p-3 text-sm font-semibold [overflow-wrap:anywhere]">
                  <span>{groupLabels[status]}</span>
                  <span
                    className="ml-2 inline-block tabular-nums text-muted-foreground"
                    data-testid={'guest-payer-group-count-' + status}
                  >
                    {paymentGroups[status].length}
                  </span>
                </summary>
                <div className="min-w-0 space-y-2 px-3 pb-3">
                  {paymentGroups[status].length === 0 && (
                    <p className="text-xs text-muted-foreground" data-testid={'guest-payer-group-empty-' + status}>
                      {t('payerPaymentGroupEmpty')}
                    </p>
                  )}
                  {paymentGroups[status].map((payment) => (
                    <div
                      key={payment.personId}
                      className="space-y-2 rounded-lg border p-3"
                      data-testid={'guest-payer-payment-' + payment.personId}
                    >
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 [overflow-wrap:anywhere] font-medium">{payment.name}</span>
                        <span
                          data-testid="guest-payer-payment-amount"
                          className="ml-auto min-w-0 max-w-full font-semibold tabular-nums [overflow-wrap:anywhere]"
                        >
                          {formatCents(payment.amount, 'RUB', locale)}
                        </span>
                      </div>
                      {payment.members && (
                        <div
                          className="min-w-0 space-y-1 text-xs text-muted-foreground"
                          data-testid={'payer-payment-group-members-' + payment.personId}
                        >
                          <p className="font-medium">{t('paymentGroupTotal')}</p>
                          {payment.members.map((member) => (
                            <p key={member.personId} className="min-w-0 break-words tabular-nums">
                              {t('paymentGroupPersonal', {
                                name:
                                  people?.find((person) => person.id === member.personId)?.name ??
                                  t('personFallback', { index: member.personIndex + 1 }),
                                amount: formatCents(member.amountCents, 'RUB', locale),
                              })}
                            </p>
                          ))}
                        </div>
                      )}
                      {payment.unmarkedAt && !payment.declaredPaidAt && !payment.verifiedAt && (
                        <p
                          role="status"
                          aria-live="polite"
                          className="min-w-0 rounded-md border border-amber-600/40 bg-amber-50 p-3 text-sm text-amber-900 [overflow-wrap:anywhere] dark:bg-amber-950/20 dark:text-amber-200"
                          data-testid={'guest-payer-unmarked-notice-' + payment.personId}
                        >
                          {t('payerPaymentDeclarationRevokedNotice', {
                            name: payment.name,
                            amount: formatCents(payment.amount, 'RUB', locale),
                          })}
                        </p>
                      )}
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
                      {payment.verifiedAt && (
                        <>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 w-full min-w-0 whitespace-normal border-green-600 bg-green-50 text-center text-green-800 [overflow-wrap:anywhere] disabled:cursor-default disabled:opacity-100 dark:border-green-700 dark:bg-green-950 dark:text-green-300"
                            disabled
                            data-testid={'guest-payer-verified-' + payment.personId}
                          >
                            {t('payerPaymentVerified')}
                          </Button>
                          <p
                            className="min-w-0 break-words text-xs text-muted-foreground"
                            data-testid={'guest-payer-verified-audit-' + payment.personId}
                          >
                            {t('payerPaymentVerifiedAudit', {
                              payer: payment.verifiedByPersonId
                                ? (people?.find((person) => person.id === payment.verifiedByPersonId)?.name ??
                                  t('payerPaymentVerifierFallback'))
                                : t('payerPaymentVerifierFallback'),
                              at: new Date(payment.verifiedAt).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US'),
                            })}
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 w-full min-w-0 whitespace-normal border-amber-600 text-center text-amber-800 [overflow-wrap:anywhere] dark:border-amber-500 dark:text-amber-300"
                            disabled={verifyingId !== null}
                            onClick={() => {
                              void cancelReceipt(payment.personId);
                            }}
                            data-testid={'guest-payer-cancel-' + payment.personId}
                          >
                            {t('payerPaymentCancelAction')}
                          </Button>
                        </>
                      )}
                      {!payment.verifiedAt && (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11 w-full min-w-0 whitespace-normal [overflow-wrap:anywhere] text-center"
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
              </details>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
