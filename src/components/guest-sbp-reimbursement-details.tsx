'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { formatSbpPhoneForDisplay, sbpPhoneForBankInput, SBP_BANKS } from '@/lib/sbp-banks';
import { SbpBankLogo } from '@/components/sbp-bank-logo';
import { copyToClipboard } from '@/lib/clipboard';
import { Button } from '@/components/ui/button';

/** Private contact: mounted only for a person with a positive finalized reimbursement. */
export function GuestSbpReimbursementDetails({
  token,
  personId,
  personToken,
  payerName,
}: {
  token: string;
  personId: string;
  personToken: string;
  payerName: string;
}) {
  const t = useTranslations('split.claim');
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
  const displayPhone = formatSbpPhoneForDisplay(contact.phone);
  const digitsForBank = sbpPhoneForBankInput(contact.phone);
  async function copyPhone() {
    if (digitsForBank && (await copyToClipboard(digitsForBank))) {
      toast.success(t('payerSbpRecipientCopied'));
    } else {
      toast.error(t('payerSbpRecipientCopyFailed'));
    }
  }
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="guest-sbp-reimbursement-details">
      <p className="text-sm font-medium">{t('payerSbpRecipientTitle')}</p>
      <p className="min-w-0 break-words text-sm" data-testid="guest-sbp-reimbursement-payer-name">
        {t('payerSbpRecipientName', { name: payerName })}
      </p>
      <div className="flex min-w-0 items-center gap-3" data-testid="guest-sbp-reimbursement-bank">
        {bank && <SbpBankLogo bank={bank} unavailableLabel={t('payerSbpLogoUnavailable')} />}
        <span className="min-w-0 flex-1 break-words text-sm">{bank?.name ?? t('payerSbpRecipientUnknownBank')}</span>
      </div>
      <p
        className="select-text break-all text-base font-semibold tabular-nums"
        data-testid="guest-sbp-reimbursement-phone"
      >
        {displayPhone ?? t('payerSbpRecipientInvalidPhone')}
      </p>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full"
        onClick={copyPhone}
        disabled={!digitsForBank}
        data-testid="guest-sbp-copy-phone"
      >
        <Copy className="mr-2 size-4" aria-hidden="true" />
        {t('payerSbpRecipientCopyPhone')}
      </Button>
      <div className="space-y-1 text-xs text-muted-foreground" data-testid="guest-sbp-manual-instructions">
        <p className="font-medium">{t('payerSbpManualTitle')}</p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>{t('payerSbpManualOpenBank')}</li>
          <li>{t('payerSbpManualChooseSbp')}</li>
          <li>{t('payerSbpManualChooseRecipientBank')}</li>
          <li>{t('payerSbpManualEnterAmount')}</li>
          <li>{t('payerSbpManualReview')}</li>
          <li>{t('payerSbpManualConfirm')}</li>
        </ol>
      </div>
      <p className="text-xs text-muted-foreground">{t('payerSbpRecipientDisclaimer')}</p>
    </div>
  );
}
