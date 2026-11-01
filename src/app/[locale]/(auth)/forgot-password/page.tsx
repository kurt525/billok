'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { trpc } from '@/lib/trpc';

export default function ForgotPasswordPage() {
  const t = useTranslations('auth.passwordReset');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'accepted' | 'failed'>('idle');
  const request = trpc.auth.requestPasswordReset.useMutation();

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.isPending) return;
    setStatus('idle');
    try {
      await request.mutateAsync({ email: email.trim() });
      setStatus('accepted');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <Card className="min-w-0 border-primary/10">
      <CardHeader>
        <CardTitle className="text-2xl">{t('requestTitle')}</CardTitle>
        <CardDescription>{t('requestDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-5">
        <form className="min-w-0 space-y-3" onSubmit={send} data-testid="forgot-password-form">
          <Label htmlFor="reset-email">{t('email')}</Label>
          <Input id="reset-email" type="email" autoComplete="email" required maxLength={254}
            autoCapitalize="none" spellCheck={false} className="h-11 min-w-0 text-base"
            value={email} onChange={(e) => { setEmail(e.target.value); setStatus('idle'); }} />
          <Button className="min-h-11 w-full whitespace-normal rounded-full text-base"
            disabled={request.isPending} type="submit">
            {request.isPending ? t('sending') : t('send')}
          </Button>
        </form>
        {status === 'accepted' && <p role="status" className="break-words text-sm">{t('accepted')}</p>}
        {status === 'failed' && <p role="alert" className="break-words text-sm text-destructive">{t('networkError')}</p>}
        <Link href="/login" className="inline-flex min-h-11 items-center text-primary underline">{t('backToLogin')}</Link>
      </CardContent>
    </Card>
  );
}
