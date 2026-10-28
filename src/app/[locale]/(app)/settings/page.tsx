'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSession } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { localizedTrpcError } from '@/lib/localized-trpc-error';
import { SBP_BANKS, searchSbpBanks } from '@/lib/sbp-banks';

// Rendered only once the profile has loaded, so all fields can be
// initialized directly from the data (no sync-from-query effects that
// could clobber in-progress edits).
function ProfileForm({
  email,
  initialName,
  initialVenmoUsername,
  initialSbpPhone,
  initialSbpBankId,
}: {
  email: string;
  initialName: string;
  initialVenmoUsername: string;
  initialSbpPhone: string;
  initialSbpBankId: string;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { update } = useSession();
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [venmoUsername, setVenmoUsername] = useState(initialVenmoUsername);
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
      venmoUsername: venmoUsername.trim() || null,
      sbpPhone: sbpPhone.trim() || null,
      sbpBankId: sbpBankId || null,
    });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t('profile.email')}</Label>
        <Input id="email" type="email" autoComplete="email" className="h-11 min-w-0 text-base" value={email} disabled />
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">{t('profile.name')}</Label>
        <Input
          id="name"
          autoComplete="off"
          className="h-11 min-w-0 text-base"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="venmo">{t('profile.venmo')}</Label>
        <Input
          id="venmo"
          className="h-11 min-w-0 text-base"
          autoCapitalize="none"
          value={venmoUsername}
          onChange={(e) => setVenmoUsername(e.target.value)}
          placeholder={t('profile.venmoPlaceholder')}
          data-testid="venmo-username-input"
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
          className="h-11 min-w-0 text-base"
          value={sbpPhone}
          onChange={(e) => setSbpPhone(e.target.value)}
          placeholder={t('profile.sbpPhonePlaceholder')}
          data-testid="sbp-phone-input"
        />
        <p className="text-xs text-muted-foreground">{t('profile.sbpPhoneUnverified')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="sbp-bank">{t('profile.sbpBank')}</Label>
        <Input
          id="sbp-bank-search"
          type="search"
          autoComplete="off"
          className="h-11 min-w-0 text-base"
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
          className="max-h-64 space-y-1 overflow-y-auto rounded-xl border p-1"
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
              {bank.icon ? (
                <Image
                  src={bank.icon}
                  width={40}
                  height={40}
                  alt=""
                  unoptimized
                  className="size-10 shrink-0 rounded-md"
                  aria-hidden="true"
                />
              ) : (
                <span
                  className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold"
                  aria-hidden="true"
                  data-testid={'sbp-bank-fallback-' + bank.id}
                >
                  {bank.name.trim().slice(0, 2).toLocaleUpperCase('ru-RU')}
                </span>
              )}
              <span className="min-w-0 flex-1 text-sm font-medium">{bank.name}</span>
              {sbpBankId === bank.id && <Check className="size-5 shrink-0" aria-hidden="true" />}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('profile.sbpBankHint')}</p>
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

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { data: session } = useSession();

  const profile = trpc.auth.getProfile.useQuery();
  const loginOptions = trpc.auth.getLoginOptions.useQuery();
  // SSO, Google and magic-link-only accounts have no password to change, and with
  // password login disabled a password would be useless anyway. Hidden while
  // the options load (no flash); shown if they fail to load, since the server
  // still enforces the setting.
  const passwordLoginEnabled = loginOptions.isSuccess ? loginOptions.data.passwordLogin : loginOptions.isError;
  const showPasswordCard = profile.data?.hasPassword === true && passwordLoginEnabled;

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const changePassword = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    },
  });

  function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) return;
    changePassword.mutate({ currentPassword, newPassword });
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
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
              initialVenmoUsername={profile.data.venmoUsername ?? ''}
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

      {showPasswordCard && (
        <Card>
          <CardHeader>
            <CardTitle>{t('password.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="currentPassword">{t('password.current')}</Label>
                <Input
                  id="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  className="h-11 min-w-0 text-base"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  minLength={1}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newPassword">{t('password.new')}</Label>
                <Input
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  className="h-11 min-w-0 text-base"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">{t('password.confirm')}</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  className="h-11 min-w-0 text-base"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                />
                {confirmPassword && newPassword !== confirmPassword && (
                  <p className="text-sm text-red-600">{t('password.mismatch')}</p>
                )}
              </div>
              <Button
                type="submit"
                className="min-h-11 w-full"
                disabled={
                  changePassword.isPending || newPassword !== confirmPassword || !currentPassword || !newPassword
                }
              >
                {changePassword.isPending ? t('password.submitting') : t('password.submit')}
              </Button>
              {changePassword.isSuccess && <p className="text-sm text-green-600">{t('password.success')}</p>}
              {changePassword.error && (
                <p className="text-sm text-red-600">{localizedTrpcError(changePassword.error, tc('errors.generic'))}</p>
              )}
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
