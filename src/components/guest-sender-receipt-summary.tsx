'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { ActualReceiptReconciliation } from '@/lib/actual-receipt-payments';
import { formatCents } from '@/lib/money';

/** A private read of the payer's reconciliation, not a recalculation of the finalized debt. */
export function GuestSenderReceiptSummary({
  receipt,
  grouped = false,
}: {
  receipt: ActualReceiptReconciliation;
  grouped?: boolean;
}) {
  const t = useTranslations('split.claim');
  const locale = useLocale();
  const rows = [
    { id: 'food', label: t('payerFoodShare'), cents: receipt.foodCents },
    { id: 'declared-tip', label: t('tipDeclaredBeforeFinalize'), cents: receipt.declaredTipCents },
    ...(receipt.extraTipCents > 0
      ? [{ id: 'extra-tip', label: t('payerAdditionalTips'), cents: receipt.extraTipCents }]
      : []),
    {
      id: 'received',
      label: t(
        receipt.refundedCents > 0 || receipt.refundDueCents > 0 || receipt.pendingExcessCents > 0
          ? 'senderActuallyTransferred'
          : receipt.outstandingCents > 0
            ? 'senderPartiallyPaid'
            : 'senderActuallyPaid',
      ),
      cents: receipt.receivedCents,
    },
    ...(receipt.outstandingCents > 0
      ? [{ id: 'outstanding', label: t('senderStillOwed'), cents: receipt.outstandingCents }]
      : []),
    ...(receipt.pendingExcessCents > 0
      ? [{ id: 'pending-excess', label: t('senderPendingExcess'), cents: receipt.pendingExcessCents }]
      : []),
    ...(receipt.refundedCents > 0
      ? [{ id: 'refunded', label: t('payerRefundedTotal'), cents: receipt.refundedCents }]
      : []),
    ...(receipt.refundDueCents > 0
      ? [{ id: 'refund-due', label: t('payerRefundDue'), cents: receipt.refundDueCents }]
      : []),
  ];
  return (
    <section
      className="min-w-0 space-y-2 rounded-md border p-3"
      aria-live="polite"
      data-testid="guest-actual-receipt-status"
    >
      <h3 className="text-sm font-semibold">{t(grouped ? 'senderGroupReceiptSummary' : 'senderReceiptSummary')}</h3>
      <dl className="min-w-0 space-y-2 text-sm">
        {rows.map(({ id, label, cents }) => (
          <div
            key={id}
            className={
              'flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 ' +
              (id === 'received' ? 'border-t pt-2 font-semibold' : '')
            }
            data-testid={'guest-sender-' + id}
          >
            <dt className="min-w-[min(100%,6rem)] flex-1 break-words">{label}</dt>
            <dd className="ml-auto shrink-0 whitespace-nowrap text-right tabular-nums">
              {formatCents(cents, 'RUB', locale)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
