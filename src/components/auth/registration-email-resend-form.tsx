'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

/**
 * Reusable, unauthenticated resend form. Does not disclose whether an account
 * or active invitation exists. The server enforces IP/email quotas.
 * Rendering this component on auth pages is a separate mobile integration step.
 */
export function RegistrationEmailResendForm({ initialEmail = '' }: { initialEmail?: string }) {
  const t = useTranslations('auth.resendVerification');
  const [email, setEmail] = useState(initialEmail);
  const [status, setStatus] = useState<'idle' | 'accepted' | 'failure'>('idle');
  const resend = trpc.auth.resendRegistrationVerification.useMutation();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (resend.isPending || !email.trim()) return;
    setStatus('idle');
    try {
      await resend.mutateAsync({ email: email.trim() });
      // Do not promise delivery: the API intentionally returns a generic
      // acknowledgement even for an unknown or no-longer-eligible address.
      setStatus('accepted');
    } catch {
      setStatus('failure');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="min-w-0 space-y-3" data-testid="registration-resend-form">
      <div className="space-y-2 text-left">
        <Label htmlFor="registration-resend-email">{t('email')}</Label>
        <Input
          id="registration-resend-email"
          type="email"
          maxLength={254}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          className="h-11 min-w-0 text-base"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setStatus('idle');
          }}
        />
      </div>
      <Button
        type="submit"
        className="min-h-11 w-full whitespace-normal rounded-full px-4 text-base"
        disabled={resend.isPending}
      >
        {resend.isPending ? t('sending') : t('submit')}
      </Button>
      {status === 'accepted' && (
        <p role="status" className="break-words text-sm text-muted-foreground">
          {t('accepted')}
        </p>
      )}
      {status === 'failure' && (
        <p role="alert" className="break-words text-sm text-destructive">
          {t('failure')}
        </p>
      )}
    </form>
  );
}
