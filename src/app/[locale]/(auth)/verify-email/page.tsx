'use client';

import { Suspense, useRef, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, MailCheck, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RegistrationEmailResendForm } from '@/components/auth/registration-email-resend-form';
import { Link } from '@/i18n/navigation';
import { classifyPasskeyRegistrationError, passkeyRegistrationMessages } from '@/lib/passkey-registration-errors';

type ConfirmationStatus =
  'idle' | 'submitting' | 'success' | 'invalid' | 'rateLimited' | keyof typeof passkeyRegistrationMessages;

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
  // A ref, not React state, is the synchronous guard against rapid double taps.
  const inFlight = useRef(false);

  async function confirm() {
    if (!validToken || inFlight.current || status === 'success' || status === 'invalid') return;
    inFlight.current = true;
    setStatus('submitting');
    try {
      // A failed capability check must not consume the verification email link.
      if (!window.isSecureContext) {
        setStatus('insecure');
        return;
      }
      if (!window.PublicKeyCredential || !navigator.credentials?.create) {
        setStatus('unsupported');
        return;
      }
      // Atomic email confirmation and bound challenge: no email login session.
      const start = await fetch('/api/webauthn/registration/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!start.ok) {
        setStatus(start.status === 429 ? 'rateLimited' : 'invalid');
        return;
      }
      const payload = (await start.json()) as { options: PublicKeyCredentialCreationOptionsJSON };
      const credential = await startRegistration({ optionsJSON: payload.options });
      const finish = await fetch('/api/webauthn/registration/finish', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credential),
      });
      if (!finish.ok) throw new Error('Passkey registration rejected');
      setStatus('success');
      window.history.replaceState(window.history.state, '', window.location.pathname);
    } catch (error) {
      setStatus(classifyPasskeyRegistrationError(error));
    } finally {
      inFlight.current = false;
    }
  }

  const expired = !validToken || status === 'invalid';
  const submitting = status === 'submitting';
  const success = status === 'success';
  const errorText =
    status === 'rateLimited'
      ? t('rateLimited')
      : status in passkeyRegistrationMessages
        ? passkeyRegistrationMessages[status as keyof typeof passkeyRegistrationMessages]
        : null;
  const retry = Boolean(errorText);
  const retryOnThisDevice = status !== 'unsupported' && status !== 'insecure';

  return (
    <Card className="min-w-0 border-primary/10 shadow-lg shadow-primary/5">
      <CardHeader className="text-center">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10">
          {success ? <CheckCircle2 className="size-6 text-primary" /> : <MailCheck className="size-6 text-primary" />}
        </div>
        <CardTitle className="text-2xl" role="heading" aria-level={1}>
          Подтверждение почты и создание Passkey
        </CardTitle>
        <CardDescription>Почта используется только для подтверждения регистрации по приглашению.</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-5 text-center">
        {success ? (
          <p role="status" className="rounded-lg bg-primary/10 p-4 text-sm text-foreground">
            Адрес подтверждён, Passkey создан. Войдите с этим ключом доступа.
          </p>
        ) : expired ? (
          <div className="min-w-0 space-y-4">
            <p role="alert" className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
              {t('invalid')}
            </p>
            <RegistrationEmailResendForm />
          </div>
        ) : (
          <>
            {errorText && (
              <p
                role="alert"
                data-testid="verify-passkey-error"
                className="min-w-0 rounded-lg bg-destructive/10 p-4 text-sm text-destructive [overflow-wrap:anywhere]"
              >
                {errorText}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Ключ доступа сохранится на вашем устройстве или в менеджере Passkey.
            </p>
            {retryOnThisDevice && (
              <Button
                type="button"
                className="min-h-11 w-full whitespace-normal rounded-full px-4 text-base"
                disabled={submitting}
                data-testid="verify-create-passkey"
                onClick={confirm}
              >
                <ShieldCheck className="mr-2 size-4" />
                {submitting
                  ? 'Проверка…'
                  : retry
                    ? 'Повторить создание Passkey'
                    : 'Подтвердить почту и создать Passkey'}
              </Button>
            )}
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
