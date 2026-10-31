'use client';

import { Suspense, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, MailCheck, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';

type ConfirmationStatus = 'idle' | 'submitting' | 'success' | 'invalid' | 'rateLimited' | 'failure';

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerificationContent />
    </Suspense>
  );
}

function VerificationContent() {
  const t = useTranslations('auth.verifyEmail');
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const validToken = /^[A-Za-z0-9_-]{43}$/.test(token);
  const [status, setStatus] = useState<ConfirmationStatus>('idle');
  const confirmation = trpc.auth.confirmEmail.useMutation();

  async function confirm() {
    if (!validToken || status === 'submitting' || status === 'success' || status === 'invalid') return;
    setStatus('submitting');
    try {
      await confirmation.mutateAsync({ token });
      setStatus('success');
      // Remove the secret from the browser URL after it has been consumed.
      window.history.replaceState(window.history.state, '', window.location.pathname);
    } catch (error: unknown) {
      if (error instanceof TRPCClientError && error.data?.code === 'BAD_REQUEST') {
        setStatus('invalid');
      } else if (error instanceof TRPCClientError && error.data?.code === 'TOO_MANY_REQUESTS') {
        setStatus('rateLimited');
      } else {
        setStatus('failure');
      }
    }
  }

  const expired = !validToken || status === 'invalid';
  const submitting = status === 'submitting';
  const success = status === 'success';
  const retry = status === 'rateLimited' || status === 'failure';

  return (
    <Card className="min-w-0 border-primary/10 shadow-lg shadow-primary/5">
      <CardHeader className="text-center">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10">
          {success ? <CheckCircle2 className="size-6 text-primary" /> : <MailCheck className="size-6 text-primary" />}
        </div>
        <CardTitle className="text-2xl">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-5 text-center">
        {success ? (
          <p role="status" className="rounded-lg bg-primary/10 p-4 text-sm text-foreground">
            {t('success')}
          </p>
        ) : expired ? (
          <p role="alert" className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
            {t('invalid')}
          </p>
        ) : (
          <>
            {retry && (
              <p role="alert" className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
                {status === 'rateLimited' ? t('rateLimited') : t('failure')}
              </p>
            )}
            <p className="text-sm text-muted-foreground">{t('instructions')}</p>
            <Button
              type="button"
              className="min-h-11 w-full whitespace-normal rounded-full px-4 text-base"
              disabled={submitting}
              onClick={confirm}
            >
              <ShieldCheck className="mr-2 size-4" />
              {submitting ? t('submitting') : retry ? t('retry') : t('confirm')}
            </Button>
          </>
        )}
        <Link
          href="/login"
          className="inline-flex min-h-11 max-w-full items-center justify-center text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('backToLogin')}
        </Link>
      </CardContent>
    </Card>
  );
}
