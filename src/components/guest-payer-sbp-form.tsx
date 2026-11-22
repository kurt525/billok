'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { normalizeSbpPhone, searchSbpBanks, SBP_BANKS } from '@/lib/sbp-banks';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SbpBankLogo } from '@/components/sbp-bank-logo';
import { Link } from '@/i18n/navigation';

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
  const read = trpc.guest.getMyPayerSbpContact.useMutation({ gcTime: 0 });
  const write = trpc.guest.setMyPayerSbpContact.useMutation({ gcTime: 0 });
  const [phone, setPhone] = useState('');
  const [bankId, setBankId] = useState('');
  const [search, setSearch] = useState('');
  const [profile, setProfile] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const readContact = read.mutateAsync;

  useEffect(() => {
    let cancelled = false;
    let accountBound = false;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void readContact({ token, personId, personToken })
        .then((data) => {
          if (cancelled || current !== generation) return;
          accountBound = 'profile' in data && data.profile === true;
          setProfile(accountBound);
          setPhone(data.phone ?? '');
          setBankId(data.bankId ?? '');
          setFailed(false);
          setLoaded(true);
        })
        .catch(() => {
          if (cancelled || current !== generation) return;
          setPhone('');
          setBankId('');
          setLoaded(false);
          setFailed(true);
        });
    };
    // Do not overwrite a guest's unsaved receipt-specific draft on focus.
    // Registered accounts always reread their profile when returning from it.
    const onVisible = () => {
      if (accountBound && document.visibilityState === 'visible') refresh();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && accountBound) refresh();
    };
    refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [readContact, token, personId, personToken]);

  const matched = useMemo(() => searchSbpBanks(search), [search]);
  const selected = SBP_BANKS.find((bank) => bank.id === bankId);
  const visible = selected && !matched.some((bank) => bank.id === selected.id) ? [selected, ...matched] : matched;
  const valid = (!phone.trim() && !bankId) || (!!normalizeSbpPhone(phone) && !!selected && selected.active !== false);
  async function save() {
    if (profile || !valid || write.isPending) return;
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
        {loaded && (
          <p className="text-xs text-muted-foreground">{t(profile ? 'payerSbpProfilePrivacy' : 'payerSbpPrivacy')}</p>
        )}
        {!loaded ? (
          <p data-testid="guest-payer-sbp-loading" className="text-sm">
            {failed ? t('payerSbpLoadError') : t('payerSbpLoading')}
          </p>
        ) : profile ? (
          <div className="min-w-0 space-y-3" data-testid="guest-payer-sbp-profile">
            {phone && (
              <p className="break-all text-sm tabular-nums" data-testid="guest-payer-profile-phone">
                {phone}
              </p>
            )}
            {selected && (
              <div
                className="flex min-w-0 items-center gap-3 rounded-lg border p-2"
                data-testid="guest-payer-profile-bank"
              >
                <SbpBankLogo bank={selected} unavailableLabel={t('payerSbpLogoUnavailable')} />
                <span className="min-w-0 flex-1 break-words text-sm">{selected.name}</span>
              </div>
            )}
            <Link
              href="/settings#sbp-phone"
              className={buttonVariants({ className: 'min-h-11 w-full whitespace-normal' })}
              data-testid="guest-payer-sbp-profile-link"
            >
              {t(phone && selected ? 'payerSbpEditProfile' : 'payerSbpFillProfile')}
            </Link>
          </div>
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
            {selected && (
              <div
                className="flex min-w-0 items-center gap-3 rounded-lg border bg-muted/30 p-2"
                data-testid="guest-payer-sbp-selected-bank"
              >
                <SbpBankLogo bank={selected} unavailableLabel={t('payerSbpLogoUnavailable')} />
                <span className="min-w-0 flex-1 break-words text-sm font-medium">{selected.name}</span>
              </div>
            )}
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
              className="max-h-48 min-w-0 space-y-1 overflow-y-auto overscroll-contain rounded-lg border p-1"
              data-testid="guest-payer-sbp-bank-list"
            >
              {visible.slice(0, 30).map((bank) => (
                <label
                  key={bank.id}
                  className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 focus-within:ring-2 focus-within:ring-ring"
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
                  <SbpBankLogo bank={bank} unavailableLabel={t('payerSbpLogoUnavailable')} />
                  <span className="min-w-0 flex-1 break-words text-sm">{bank.name}</span>
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
