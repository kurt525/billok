'use client';

import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { cn } from '@/lib/utils';
import { signOut, useSession } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { localizedTrpcError } from '@/lib/localized-trpc-error';
import { SBP_BANKS, searchSbpBanks } from '@/lib/sbp-banks';
import { SbpBankLogo } from '@/components/sbp-bank-logo';

// Rendered only once the profile has loaded, so all fields can be
// initialized directly from the data (no sync-from-query effects that
// could clobber in-progress edits).
function ProfileForm({
  email,
  initialName,
  initialSbpPhone,
  initialSbpBankId,
}: {
  email: string;
  initialName: string;
  initialSbpPhone: string;
  initialSbpBankId: string;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { update } = useSession();
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [sbpPhone, setSbpPhone] = useState(initialSbpPhone);
  const [sbpBankId, setSbpBankId] = useState(initialSbpBankId);
  const [sbpBankSearch, setSbpBankSearch] = useState('');
  const matchingSbpBanks = searchSbpBanks(sbpBankSearch);
  const selectedSbpBank = SBP_BANKS.find((bank) => bank.id === sbpBankId);
  // A search must not clear the payer's saved bank when it filters the list.
  const visibleSbpBanks =
    selectedSbpBank && !matchingSbpBanks.some((bank) => bank.id === selectedSbpBank.id)
      ? [selectedSbpBank, ...matchingSbpBanks]
      : matchingSbpBanks;

  const updateProfile = trpc.auth.updateProfile.useMutation({
    onSuccess: async () => {
      await update();
      router.refresh();
    },
  });

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    updateProfile.mutate({
      name: name.trim(),
      sbpPhone: sbpPhone.trim() || null,
      sbpBankId: sbpBankId || null,
    });
  }

  return (
    <form onSubmit={handleSave} className="min-w-0 space-y-4" data-testid="mobile-profile-form">
      <div className="space-y-2">
        <Label htmlFor="email">{t('profile.email')}</Label>
        <Input id="email" type="email" autoComplete="email" className="h-11 min-w-0 text-base" value={email} disabled />
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">{t('profile.name')}</Label>
        <Input
          id="name"
          autoComplete="off"
          maxLength={100}
          className="h-11 min-w-0 text-base"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="sbp-phone">{t('profile.sbpPhone')}</Label>
        <Input
          id="sbp-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={24}
          className="h-11 min-w-0 scroll-mt-20 text-base"
          value={sbpPhone}
          onChange={(e) => setSbpPhone(e.target.value)}
          placeholder={t('profile.sbpPhonePlaceholder')}
          data-testid="sbp-phone-input"
        />
        <p className="text-xs text-muted-foreground">{t('profile.sbpPhoneUnverified')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="sbp-bank">{t('profile.sbpBank')}</Label>
        {selectedSbpBank && (
          <div
            className="flex min-w-0 items-center gap-3 rounded-lg border bg-muted/30 p-2"
            data-testid="sbp-bank-selected"
          >
            <SbpBankLogo bank={selectedSbpBank} unavailableLabel={t('profile.sbpBankLogoUnavailable')} />
            <span className="min-w-0 flex-1 break-words text-sm font-medium">{selectedSbpBank.name}</span>
            {selectedSbpBank.active === false && (
              <span className="text-xs text-muted-foreground">{t('profile.sbpBankRemoved')}</span>
            )}
          </div>
        )}
        <Input
          id="sbp-bank-search"
          type="search"
          autoComplete="off"
          className="h-11 min-w-0 scroll-mt-20 text-base"
          placeholder={t('profile.sbpBankSearchPlaceholder')}
          aria-label={t('profile.sbpBankSearch')}
          value={sbpBankSearch}
          onChange={(e) => setSbpBankSearch(e.target.value)}
          data-testid="sbp-bank-search"
        />
        {sbpBankSearch.trim() && matchingSbpBanks.length === 0 && (
          <p className="text-xs text-muted-foreground" data-testid="sbp-bank-no-results">
            {t('profile.sbpBankNoResults')}
          </p>
        )}
        <div
          role="radiogroup"
          aria-label={t('profile.sbpBank')}
          className="max-h-[min(16rem,36dvh)] min-w-0 space-y-1 overflow-y-auto overscroll-contain rounded-xl border p-1"
          data-testid="sbp-bank-list"
        >
          <label
            className={cn(
              'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 focus-within:ring-2 focus-within:ring-ring',
              sbpBankId === '' ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted/50',
            )}
            data-testid="sbp-bank-option-none"
          >
            <input
              type="radio"
              name="sbp-bank"
              value=""
              checked={sbpBankId === ''}
              onChange={() => setSbpBankId('')}
              className="sr-only"
              data-testid="sbp-bank-radio-none"
            />
            <span className="min-w-0 flex-1 text-sm">{t('profile.sbpBankNotSelected')}</span>
            {sbpBankId === '' && <Check className="size-5 shrink-0" aria-hidden="true" />}
          </label>
          {visibleSbpBanks.map((bank) => (
            <label
              key={bank.id}
              className={cn(
                'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-2 py-1 focus-within:ring-2 focus-within:ring-ring',
                sbpBankId === bank.id ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted/50',
              )}
              data-testid={'sbp-bank-option-' + bank.id}
            >
              <input
                type="radio"
                name="sbp-bank"
                value={bank.id}
                checked={sbpBankId === bank.id}
                onChange={() => setSbpBankId(bank.id)}
                className="sr-only"
                data-testid={'sbp-bank-radio-' + bank.id}
              />
              <SbpBankLogo bank={bank} unavailableLabel={t('profile.sbpBankLogoUnavailable')} />
              <span className="min-w-0 flex-1 text-sm font-medium">
                {bank.name}
                {bank.active === false && (
                  <span className="block text-xs text-muted-foreground">{t('profile.sbpBankRemoved')}</span>
                )}
              </span>
              {sbpBankId === bank.id && <Check className="size-5 shrink-0" aria-hidden="true" />}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('profile.sbpBankHint')}</p>
        <p className="text-xs text-muted-foreground" data-testid="sbp-profile-receipt-scope">
          {t('profile.sbpReceiptScope')}
        </p>
      </div>
      <Button
        type="submit"
        className="min-h-11 w-full"
        disabled={updateProfile.isPending}
        data-testid="save-profile-btn"
      >
        {updateProfile.isPending ? t('profile.saving') : t('profile.save')}
      </Button>
      {updateProfile.isSuccess && <p className="text-sm text-green-600">{t('profile.saved')}</p>}
      {updateProfile.error && (
        <p className="text-sm text-red-600">{localizedTrpcError(updateProfile.error, tc('errors.generic'))}</p>
      )}
    </form>
  );
}

function PasskeyInventory() {
  const t = useTranslations('settings.passkeys');
  const [selectedLostKey, setSelectedLostKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState('');
  const inFlight = useRef(false);
  async function confirmLostKeyRevocation() {
    if (!selectedLostKey || inFlight.current) return;
    inFlight.current = true;
    setRevoking(true);
    setRevokeError('');
    try {
      if (!window.PublicKeyCredential) throw new Error('unsupported');
      const started = await fetch('/api/webauthn/owner/revoke/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: selectedLostKey }),
      });
      if (!started.ok) throw new Error('start refused');
      const { options } = (await started.json()) as {
        options: PublicKeyCredentialRequestOptionsJSON;
      };
      const assertion = await startAuthentication({ optionsJSON: options });
      const finished = await fetch('/api/webauthn/owner/revoke/finish', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assertion),
      });
      if (!finished.ok) throw new Error('finish refused');
      // The server invalidated ALL JWTs to protect sessions on the lost
      // device. Clear this browser cookie and require a fresh Passkey login.
      try {
        await signOut({ callbackUrl: '/login' });
      } catch {
        // Revocation already committed: a failed client-side cookie cleanup
        // must not falsely tell the owner that the lost key is still active.
        window.location.replace('/login');
      }
    } catch {
      setRevokeError(t('revokeFailed'));
    } finally {
      inFlight.current = false;
      setRevoking(false);
    }
  }

  const { data, isPending, error } = trpc.auth.listPasskeys.useQuery(undefined, {
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const formatDate = (value: Date | string) =>
    new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  const deviceLabel = (value: string) =>
    value === 'multiDevice' ? t('syncable') : value === 'singleDevice' ? t('singleDevice') : t('typeUnknown');

  return (
    <Card data-testid="passkey-inventory" className="min-w-0">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {isPending && <p role="status">{t('loading')}</p>}
        {error && <p role="alert">{t('error')}</p>}
        {data && (
          <>
            <p data-testid="passkey-limit" className="text-sm font-medium">
              {t('count', { count: data.activeCount, limit: data.maxActivePasskeys })}
            </p>
            {data.credentials.length === 0 && <p>{t('empty')}</p>}
            <ul className="min-w-0 space-y-3" data-testid="passkey-items">
              {data.credentials.map((key) => (
                <li key={key.id} data-testid="passkey-item" className="min-w-0 space-y-1 rounded-xl border p-3">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0 break-words font-medium">{key.label || t('nameFallback')}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {key.revokedAt ? t('revoked') : t('active')}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{deviceLabel(key.deviceType)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('backupLabel')}: {key.backedUp ? t('backedUp') : t('notBackedUp')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('created')}: {formatDate(key.createdAt)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('lastUsed')}: {key.lastUsedAt ? formatDate(key.lastUsedAt) : t('neverUsed')}
                  </p>
                  {data.isOwner && !key.revokedAt && data.activeCount > 1 && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 max-w-full whitespace-normal"
                      data-testid={'owner-revoke-key-' + key.id}
                      disabled={revoking}
                      onClick={() => {
                        setSelectedLostKey(key.id);
                        setRevokeError('');
                      }}
                    >
                      {t('markLost')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {data.isOwner && data.activeCount <= 1 && (
              <p className="text-sm text-muted-foreground">{t('lastKeyProtected')}</p>
            )}
            {data.isOwner && selectedLostKey && data.activeCount > 1 && (
              <div className="min-w-0 space-y-3 rounded-xl border p-3" data-testid="owner-revoke-confirmation">
                <p className="break-words text-sm font-medium">{t('revokeConfirm')}</p>
                <p className="break-words text-sm text-muted-foreground">{t('revokeWarning')}</p>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={revoking}
                    variant="destructive"
                    className="min-h-11 max-w-full whitespace-normal"
                    data-testid="owner-revoke-confirm"
                    onClick={() => void confirmLostKeyRevocation()}
                  >
                    {revoking ? t('revoking') : t('revokeNow')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={revoking}
                    data-testid="owner-revoke-cancel"
                    className="min-h-11"
                    onClick={() => {
                      setSelectedLostKey(null);
                      setRevokeError('');
                    }}
                  >
                    {t('cancelRevoke')}
                  </Button>
                </div>
              </div>
            )}
            {revokeError && (
              <p role="alert" className="break-words text-sm text-destructive">
                {revokeError}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('deviceHint')}</p>
            <p className="text-xs text-muted-foreground">{data.isOwner ? t('pendingOwner') : t('pendingRegular')}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const t = useTranslations('settings');
  const { data: session } = useSession();

  const profile = trpc.auth.getProfile.useQuery();
  return (
    <div className="mx-auto min-w-0 max-w-lg space-y-6 pb-[calc(2rem+env(safe-area-inset-bottom))]">
      <h1 className="text-2xl font-bold">{t('title')}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t('profile.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {profile.data ? (
            <ProfileForm
              email={profile.data.email ?? session?.user?.email ?? ''}
              initialName={profile.data.name ?? session?.user?.name ?? ''}
              initialSbpPhone={profile.data.sbpPhone ?? ''}
              initialSbpBankId={profile.data.sbpBankId ?? ''}
            />
          ) : (
            <div className="space-y-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2">
                  <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                  <div className="h-9 w-full animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <PasskeyInventory />
    </div>
  );
}
