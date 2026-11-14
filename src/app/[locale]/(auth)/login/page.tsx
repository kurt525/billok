'use client';

import { Suspense, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { signIn, signOut } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { KeyRound, Receipt } from 'lucide-react';
import { normalizeCallbackPath, stripLocalePrefix } from '@/lib/locale-paths';
import { getSignInErrorKey } from '@/lib/sign-in-errors';

/** Passkey-only entrypoint. No password or email-link fallback. */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const t = useTranslations('auth.login');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const callbackPath = normalizeCallbackPath(params.get('callbackUrl'), locale);
  const callbackHref = stripLocalePrefix(callbackPath);
  const registerHref = '/register?callbackUrl=' + encodeURIComponent(callbackPath);
  const urlErrorKey = getSignInErrorKey(params.get('error'));
  const shownError =
    error ||
    (urlErrorKey === 'sessionActive'
      ? t('errors.sessionActive')
      : urlErrorKey === 'pendingEmailConfirmation'
        ? t('errors.pendingEmailConfirmation')
        : urlErrorKey
          ? t('errors.generic')
          : '');
  const showSignOut = !error && urlErrorKey === 'sessionActive';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      if (typeof window === 'undefined' || !window.PublicKeyCredential) {
        throw new Error('passkey unavailable');
      }
      const start = await fetch('/api/webauthn/authentication/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!start.ok) throw new Error('challenge rejected');
      const data = (await start.json()) as { options: PublicKeyCredentialRequestOptionsJSON };
      const assertion = await startAuthentication({ optionsJSON: data.options });
      const finish = await fetch('/api/webauthn/authentication/finish', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assertion),
      });
      if (!finish.ok) throw new Error('assertion rejected');
      const proof = (await finish.json()) as { loginTicket: string };
      const result = await signIn('passkey', {
        ticket: proof.loginTicket,
        redirect: false,
        callbackUrl: callbackPath,
      });
      if (result?.error) throw new Error('session rejected');
      router.push(callbackHref);
      router.refresh();
    } catch {
      setError('Не удалось войти с ключом доступа. Проверьте Passkey и попробуйте ещё раз.');
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
        <CardDescription className="mt-1">Вход только с Passkey, без пароля и ссылки из письма.</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 pt-4">
        {shownError && (
          <div
            role="alert"
            data-testid="login-error"
            className="mb-4 min-w-0 rounded-md bg-destructive/10 p-3 text-sm text-destructive [overflow-wrap:anywhere]"
          >
            {shownError}
            {showSignOut && (
              <Button
                data-testid="login-sign-out"
                variant="link"
                className="ml-1 h-auto p-0 text-sm text-destructive underline"
                onClick={() => {
                  setSignOutFailed(false);
                  signOut({ callbackUrl: '/' + locale + '/login' }).catch(() => setSignOutFailed(true));
                }}
              >
                {tCommon('nav.signOut')}
              </Button>
            )}
            {showSignOut && signOutFailed && (
              <span data-testid="login-sign-out-failed" className="block">
                {tCommon('errors.generic')}
              </span>
            )}
          </div>
        )}
        <form onSubmit={handleSubmit} className="min-w-0 space-y-4" data-testid="mobile-login-form">
          <Button
            type="submit"
            className="mt-2 min-h-11 w-full rounded-full text-base font-medium"
            disabled={loading}
            data-testid="passkey-login"
          >
            <KeyRound className="mr-2 size-4" aria-hidden="true" />
            {loading ? 'Проверка ключа…' : 'Войти с Passkey'}
          </Button>
        </form>
        <div className="mt-4 text-center">
          <Link href="/recover-passkey" className="inline-flex min-h-11 items-center text-sm underline">
            Потеряли Passkey? Восстановить доступ
          </Link>
        </div>
        <p className="mt-7 text-center text-sm text-muted-foreground">
          {t('noAccount')}{' '}
          <Link href={registerHref} className="font-medium text-primary hover:underline">
            {t('createAccount')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
