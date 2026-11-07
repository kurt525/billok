'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { SBP_BANKS } from '@/lib/sbp-banks';
import { copyToClipboard } from '@/lib/clipboard';
import { Button } from '@/components/ui/button';

/** Private contact: mounted only for a person with a positive finalized reimbursement. */
export function GuestSbpReimbursementDetails({
  token,
  personId,
  personToken,
}: {
  token: string;
  personId: string;
  personToken: string;
}) {
  const t = useTranslations('split.claim');
  const tc = useTranslations('common');
  const read = trpc.guest.getPayerSbpForReimbursement.useMutation();
  const [contact, setContact] = useState<{ phone: string | null; bankId: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const readContact = read.mutateAsync;

  useEffect(() => {
    let cancelled = false;
    void readContact({ token, personId, personToken })
      .then((value) => {
        if (!cancelled) setContact(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [readContact, token, personId, personToken]);

  if (failed) return <p className="text-xs text-muted-foreground">{t('payerSbpRecipientUnavailable')}</p>;
  if (!contact) return <p className="text-xs text-muted-foreground">{t('payerSbpRecipientLoading')}</p>;
  if (!contact.phone || !contact.bankId) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="guest-sbp-not-configured">
        {t('payerSbpRecipientNotConfigured')}
      </p>
    );
  }
  const bank = SBP_BANKS.find((entry) => entry.id === contact.bankId);
  async function copyPhone() {
    if (await copyToClipboard(contact!.phone!)) {
      toast.success(t('payerSbpRecipientCopied'));
    } else {
      toast.error(tc('actions.copyFailed'));
    }
  }
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="guest-sbp-reimbursement-details">
      <p className="text-sm font-medium">{t('payerSbpRecipientTitle')}</p>
      <p className="text-sm" data-testid="guest-sbp-reimbursement-bank">
        {bank?.name ?? t('payerSbpRecipientUnknownBank')}
      </p>
      <p className="text-base font-semibold tabular-nums" data-testid="guest-sbp-reimbursement-phone">
        {contact.phone}
      </p>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full"
        onClick={copyPhone}
        data-testid="guest-sbp-copy-phone"
      >
        <Copy className="mr-2 size-4" aria-hidden="true" />
        {t('payerSbpRecipientCopyPhone')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('payerSbpRecipientDisclaimer')}</p>
    </div>
  );
}
