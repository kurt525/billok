'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { normalizeSbpPhone, searchSbpBanks, SBP_BANKS } from '@/lib/sbp-banks';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export function GuestPayerSbpForm({
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
  const read = trpc.guest.getMyPayerSbpContact.useMutation();
  const write = trpc.guest.setMyPayerSbpContact.useMutation();
  const [phone, setPhone] = useState('');
  const [bankId, setBankId] = useState('');
  const [search, setSearch] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const readContact = read.mutateAsync;

  useEffect(() => {
    let cancelled = false;
    void readContact({ token, personId, personToken })
      .then((data) => {
        if (cancelled) return;
        setPhone(data.phone ?? '');
        setBankId(data.bankId ?? '');
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [readContact, token, personId, personToken]);

  const matched = useMemo(() => searchSbpBanks(search), [search]);
  const selected = SBP_BANKS.find((bank) => bank.id === bankId);
  const visible = selected && !matched.some((bank) => bank.id === selected.id) ? [selected, ...matched] : matched;
  const valid = (!phone.trim() && !bankId) || (!!normalizeSbpPhone(phone) && !!selected && selected.active !== false);
  async function save() {
    if (!valid || write.isPending) return;
    const empty = !phone.trim();
    try {
      await write.mutateAsync({
        token,
        personId,
        personToken,
        phone: empty ? null : phone.trim(),
        bankId: empty ? null : bankId,
      });
      if (!empty) setPhone(normalizeSbpPhone(phone)!);
      toast.success(t('payerSbpSaved'));
    } catch {
      toast.error(tc('errors.generic'));
    }
  }
  return (
    <Card data-testid="guest-payer-sbp-form">
      <CardContent className="space-y-3 py-4">
        <h3 className="font-semibold">{t('payerSbpTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('payerSbpPrivacy')}</p>
        {!loaded ? (
          <p data-testid="guest-payer-sbp-loading" className="text-sm">
            {failed ? t('payerSbpLoadError') : t('payerSbpLoading')}
          </p>
        ) : (
          <>
            <label className="block text-sm font-medium" htmlFor="guest-sbp-phone">
              {t('payerSbpPhone')}
            </label>
            <Input
              id="guest-sbp-phone"
              type="tel"
              inputMode="tel"
              maxLength={24}
              className="min-h-11 min-w-0 text-base"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 999 123-45-67"
              data-testid="guest-payer-sbp-phone"
            />
            <label className="block text-sm font-medium" htmlFor="guest-sbp-search">
              {t('payerSbpBank')}
            </label>
            <Input
              id="guest-sbp-search"
              type="search"
              autoComplete="off"
              className="min-h-11 min-w-0 text-base"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('payerSbpSearch')}
              data-testid="guest-payer-sbp-search"
            />
            <div
              role="radiogroup"
              aria-label={t('payerSbpBank')}
              className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-1"
              data-testid="guest-payer-sbp-bank-list"
            >
              {visible.slice(0, 30).map((bank) => (
                <label
                  key={bank.id}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-1 focus-within:ring-2 focus-within:ring-ring"
                  data-testid={'guest-payer-sbp-bank-' + bank.id}
                >
                  <input
                    type="radio"
                    name="guest-payer-sbp-bank"
                    value={bank.id}
                    checked={bankId === bank.id}
                    onChange={() => setBankId(bank.id)}
                    disabled={bank.active === false}
                    className="size-4"
                  />
                  <span className="min-w-0 flex-1 text-sm">{bank.name}</span>
                </label>
              ))}
              {matched.length === 0 && <p className="p-2 text-sm text-muted-foreground">{t('payerSbpNoBanks')}</p>}
            </div>
            <p className="text-xs text-muted-foreground">{t('payerSbpUnverified')}</p>
            <Button
              type="button"
              className="min-h-11 w-full"
              onClick={save}
              disabled={!valid || write.isPending}
              data-testid="guest-payer-sbp-save"
            >
              {t('payerSbpSave')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full"
              onClick={() => {
                setPhone('');
                setBankId('');
              }}
              disabled={write.isPending}
              data-testid="guest-payer-sbp-clear"
            >
              {t('payerSbpClear')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
