'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const t = useTranslations('auth.passwordReset');
  const token = useSearchParams().get('token') ?? '';
  const valid = /^[A-Za-z0-9_-]{43}$/.test(token);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [status, setStatus] = useState<'idle' | 'success' | 'invalid' | 'failure'>('idle');
  const reset = trpc.auth.resetPassword.useMutation();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valid || reset.isPending || status === 'success' || status === 'invalid') return;
    if (password !== repeat) {
      setStatus('failure');
      return;
    }
    setStatus('idle');
    try {
      await reset.mutateAsync({ token, newPassword: password });
      setPassword('');
      setRepeat('');
      setStatus('success');
      window.history.replaceState(window.history.state, '', window.location.pathname);
    } catch (error: unknown) {
      // Both already-used and expired links receive the same safe rejection.
      if (
        error &&
        typeof error === 'object' &&
        'data' in error &&
        (error as { data?: { code?: string } }).data?.code === 'BAD_REQUEST'
      ) {
        setStatus('invalid');
      } else {
        setStatus('failure');
      }
    }
  }

  return (
    <Card className="min-w-0 border-primary/10">
      <CardHeader>
        <CardTitle className="text-2xl">{t('resetTitle')}</CardTitle>
        <CardDescription>{t('resetDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-5">
        {status === 'success' ? (
          <p role="status">{t('success')}</p>
        ) : !valid || status === 'invalid' ? (
          <p role="alert" className="text-sm text-destructive">
            {t('invalid')}
          </p>
        ) : (
          <form onSubmit={submit} className="min-w-0 space-y-3" data-testid="reset-password-form">
            <Label htmlFor="reset-new-password">{t('password')}</Label>
            <Input
              id="reset-new-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              maxLength={100}
              className="h-11 min-w-0 text-base"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Label htmlFor="reset-repeat-password">{t('repeatPassword')}</Label>
            <Input
              id="reset-repeat-password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              maxLength={100}
              className="h-11 min-w-0 text-base"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
            <Button
              type="submit"
              className="min-h-11 w-full whitespace-normal rounded-full text-base"
              disabled={reset.isPending}
            >
              {reset.isPending ? t('saving') : t('save')}
            </Button>
            {status === 'failure' && (
              <p role="alert" className="text-sm text-destructive">
                {t('failure')}
              </p>
            )}
          </form>
        )}
        <Link href="/login" className="inline-flex min-h-11 items-center text-primary underline">
          {t('backToLogin')}
        </Link>
      </CardContent>
    </Card>
  );
}
