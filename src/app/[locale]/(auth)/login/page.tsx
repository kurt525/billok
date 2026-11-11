'use client';

import { Suspense, useState } from 'react';
import { signIn, signOut } from 'next-auth/react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Receipt } from 'lucide-react';
import { normalizeCallbackPath, stripLocalePrefix } from '@/lib/locale-paths';
import { getSignInErrorKey } from '@/lib/sign-in-errors';

/** Temporary password UI until Issue #1 6.3.2.3 passkey-only cutover.
 * No OAuth, SSO, Google or email magic-link paths are present.
 */
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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    setError('');
    setLoading(true);
    try {
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
        callbackUrl: callbackPath,
      });
      if (result?.error) {
        setError(t('error'));
      } else {
        router.push(callbackHref);
        router.refresh();
      }
    } catch {
      setError(t('error'));
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
          <div className="space-y-2">
            <Label htmlFor="email">{t('email')}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className="h-11 min-w-0 text-base"
              placeholder={t('emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <Label htmlFor="password">{t('password')}</Label>
              <Link
                href="/forgot-password"
                className="inline-flex min-h-11 items-center text-sm text-primary hover:text-primary/80"
              >
                {t('forgotPassword')}
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              className="h-11 min-w-0 text-base"
              placeholder={t('passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <Button type="submit" className="w-full rounded-full min-h-11 text-base font-medium mt-2" disabled={loading}>
            {loading ? t('submitting') : t('submit')}
          </Button>
        </form>
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
