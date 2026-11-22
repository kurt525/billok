'use client';

import { useTranslations } from 'next-intl';
import { formatReceiptLinkExpiry } from '@/lib/receipt-link-expiry';

export function ReceiptLinkExpiry({ expiresAt, archived = false }: { expiresAt: Date | string; archived?: boolean }) {
  const t = useTranslations('split.result');
  return (
    <p
      className="min-w-0 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]"
      data-testid="receipt-link-expiry"
    >
      {archived ? t('expiredCreatorHistory') : t('expiresOn', { date: formatReceiptLinkExpiry(expiresAt) })}
    </p>
  );
}
