'use client';

import { Suspense, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { RegistrationEmailResendForm } from '@/components/auth/registration-email-resend-form';
import { Separator } from '@/components/ui/separator';
import { Receipt } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { normalizeCallbackPath } from '@/lib/locale-paths';

type RegistrationErrorKey =
  'emailTaken' | 'inviteRequired' | 'inviteInvalid' | 'closed' | 'emailDomain' | 'emailUnavailable' | 'generic';

function getRegistrationErrorKey(error: unknown): RegistrationErrorKey {
  if (!(error instanceof TRPCClientError)) {
    return 'generic';
  }

  if (error.data?.code === 'CONFLICT') {
    return 'emailTaken';
  }

  if (error.data?.messageKey === 'registrationEmailDomainInvalid') {
    return 'emailDomain';
  }
  if (error.data?.messageKey === 'registrationEmailUnavailable') {
    return 'emailUnavailable';
  }

  if (error.data?.code !== 'FORBIDDEN') {
    return 'generic';
  }

  // The message is in the page's language; the key isn't (#266)
  switch (error.data?.messageKey) {
    case 'inviteCodeRequired':
      return 'inviteRequired';
    case 'inviteCodeInvalid':
      return 'inviteInvalid';
    case 'registrationClosed':
      return 'closed';
    default:
      return 'generic';
  }
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const t = useTranslations('auth.register');
  const locale = useLocale() as Locale;
  const searchParams = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);

  const regMode = trpc.auth.getRegistrationMode.useQuery();
  const registerMutation = trpc.auth.register.useMutation();

  const mode = regMode.data?.mode ?? 'open';
  const callbackPath = normalizeCallbackPath(searchParams.get('callbackUrl'), locale);
  const loginHref = `/login?callbackUrl=${encodeURIComponent(callbackPath)}`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    // The server refuses a name that's only spaces (#270), which no retry fixes (#265)
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(t('error.nameRequired'));
      return;
    }
    setLoading(true);

    try {
      const registration = await registerMutation.mutateAsync({
        name: trimmedName,
        email,
        ...(mode === 'invite-only' && inviteCode ? { inviteCode } : {}),
      });

      // Registration does not sign in: email confirmation and WebAuthn are mandatory.
      if (registration.verificationRequired) setConfirmationEmail(registration.email);
    } catch (err: unknown) {
      setError(t(`error.${getRegistrationErrorKey(err)}`));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="min-w-0 border-primary/10 shadow-lg shadow-primary/5">
      <CardHeader className="text-center pb-2">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <Receipt className="h-7 w-7 text-primary" />
        </div>
        <CardTitle className="text-2xl font-semibold tracking-tight">{t('title')}</CardTitle>
        <CardDescription className="mt-1">{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 pt-4">
        {confirmationEmail !== null ? (
          <div className="space-y-4" role="status" aria-live="polite">
            <p className="text-base font-semibold">{t('confirmationPendingTitle')}</p>
            <p className="min-w-0 text-sm [overflow-wrap:anywhere]">
              {t('confirmationPendingDescription', { email: confirmationEmail })}
            </p>
            <p className="text-sm text-muted-foreground">{t('confirmationPendingSpamHint')}</p>
            <RegistrationEmailResendForm initialEmail={confirmationEmail} />
            <Link href={loginHref} className="inline-flex min-h-11 items-center font-medium text-primary underline">
              {t('signIn')}
            </Link>
          </div>
        ) : regMode.isPending ? (
          <LoadingSpinner className="py-8" />
        ) : mode === 'closed' ? (
          // The invited registration form is disabled by the administrator: do not show a
          // form that can never be submitted.
          <div className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            {t('error.closed')}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="min-w-0 space-y-4" data-testid="mobile-register-form">
            {error && (
              <div
                role="alert"
                className="min-w-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive [overflow-wrap:anywhere]"
              >
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="name">{t('name')}</Label>
              <Input
                id="name"
                type="text"
                maxLength={100}
                autoComplete="off"
                className="h-11 min-w-0 text-base"
                placeholder={t('namePlaceholder')}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError('');
                }}
                required
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? 'name-error' : undefined}
              />
              {nameError && (
                <p id="name-error" className="text-sm text-destructive [overflow-wrap:anywhere]">
                  {nameError}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{t('email')}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                className="h-11 min-w-0 text-base"
                placeholder={t('emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            {mode === 'invite-only' && (
              <div className="space-y-2">
                <Label htmlFor="inviteCode">{t('inviteCode')}</Label>
                <Input
                  id="inviteCode"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="h-11 min-w-0 text-base"
                  placeholder={t('inviteCodePlaceholder')}
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  required
                />
                <p className="text-xs text-muted-foreground">{t('error.inviteRequired')}</p>
              </div>
            )}
            <Button
              type="submit"
              className="mt-2 min-h-11 w-full whitespace-normal rounded-full text-base font-medium"
              disabled={loading}
            >
              {loading ? t('submitting') : t('submit')}
            </Button>
          </form>
        )}

        <div className="relative my-8">
          <Separator />
        </div>

        <p className="text-center text-sm text-muted-foreground">
          {t('hasAccount')}{' '}
          <Link href={loginHref} className="inline-flex min-h-11 items-center font-medium text-primary hover:underline">
            {t('signIn')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
