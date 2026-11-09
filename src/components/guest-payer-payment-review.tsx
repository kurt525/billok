'use client';

import { useEffect, useRef, useState } from 'react';
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
          setLoadFailed(false);
        })
        .catch(() => {
          if (!cancelled && !writeInFlight.current && readId === latestRead.current) setLoadFailed(true);
        });
    };
    refreshCurrent.current = refresh;
    refresh();
    const interval = setInterval(refresh, 12000);
    return () => {
      cancelled = true;
      clearInterval(interval);
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
    if (
      verifyingId ||
      writeInFlight.current ||
      !payments?.some((p) => p.personId === debtorId && p.declaredPaidAt && !p.verifiedAt)
    )
      return;
    writeInFlight.current = true;
    latestRead.current += 1;
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
      writeInFlight.current = false;
      setVerifyingId(null);
      refreshCurrent.current();
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
        )}
      </CardContent>
    </Card>
  );
}
