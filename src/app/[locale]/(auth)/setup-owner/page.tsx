'use client';

import { Suspense, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Phase = 'first' | 'login' | 'done';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Процедура не завершена. Проверьте ключ и повторите попытку.');
  return res.json() as Promise<T>;
}

/** This page never creates the owner account or selects its email. Only the
 * local-only server CLI can do that. A verified email token permits just the
 * FIRST key. Additional keys (up to three total) are optional later.
 */
export default function SetupOwnerPage() {
  return (
    <Suspense>
      <OwnerSetup />
    </Suspense>
  );
}

function OwnerSetup() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [phase, setPhase] = useState<Phase>(TOKEN_PATTERN.test(token) ? 'first' : 'login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (typeof window === 'undefined' || !window.PublicKeyCredential) {
        setError('На этом устройстве нет поддержки Passkeys. Используйте современный браузер.');
        return;
      }
      await action();
    } catch {
      // Browser, network and API errors are not safe UI strings.
      setError('Не удалось завершить настройку ключа доступа. Проверьте устройство и повторите попытку.');
    } finally {
      setBusy(false);
    }
  }

  function registerFirst() {
    void run(async () => {
      if (!TOKEN_PATTERN.test(token)) throw new Error('Ссылка подтверждения недействительна.');
      const start = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON }>(
        '/api/webauthn/registration/start',
        { token },
      );
      const credential = await startRegistration({ optionsJSON: start.options });
      await postJson('/api/webauthn/registration/finish', credential);
      window.history.replaceState(null, '', window.location.pathname);
      setNotice('Ключ доступа создан. Войдите с ним, чтобы завершить настройку владельца.');
      setPhase('login');
    });
  }

  function loginWithFirst() {
    void run(async () => {
      const start = await postJson<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        '/api/webauthn/authentication/start',
        {},
      );
      const assertion = await startAuthentication({ optionsJSON: start.options });
      const proof = await postJson<{ loginTicket: string }>('/api/webauthn/authentication/finish', assertion);
      const session = await signIn('passkey', {
        ticket: proof.loginTicket,
        redirect: false,
        callbackUrl: '/setup-owner',
      });
      if (session?.error) throw new Error('Не удалось завершить вход. Повторите попытку.');
      const status = await fetch('/api/webauthn/owner/bootstrap/status', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!status.ok) throw new Error('Этот ключ не принадлежит владельцу BillOK.');
      const result = (await status.json()) as { completed: boolean; firstKeyAdded: boolean };
      if (!result.completed || !result.firstKeyAdded) {
        throw new Error('Первоначальная настройка владельца ещё не завершена.');
      }
      setPhase('done');
      setNotice('Настройка владельца завершена. Дополнительные Passkey необязательны.');
    });
  }

  const heading =
    phase === 'first'
      ? 'Создайте первый ключ доступа'
      : phase === 'login'
        ? 'Подтвердите первый ключ'
        : 'Настройка завершена';
  return (
    <Card data-testid="owner-passkey-setup" className="min-w-0 border-primary/10 shadow-lg">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
          {phase === 'done' ? (
            <ShieldCheck className="size-6 text-primary" />
          ) : (
            <KeyRound className="size-6 text-primary" />
          )}
        </div>
        <CardTitle className="text-xl sm:text-2xl">{heading}</CardTitle>
        <CardDescription>
          Первоначальная настройка владельца BillOK без пароля. Электронная почта используется только для подтверждения
          адреса.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {notice && (
          <p role="status" className="break-words rounded-lg bg-primary/10 p-3 text-sm">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="break-words rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {phase === 'first' && (
          <Button
            data-testid="owner-create-first-passkey"
            type="button"
            disabled={busy}
            onClick={registerFirst}
            className="min-h-11 w-full whitespace-normal"
          >
            {busy ? 'Проверка…' : 'Подтвердить почту и создать Passkey'}
          </Button>
        )}
        {phase === 'login' && (
          <Button
            data-testid="owner-login-first-passkey"
            type="button"
            disabled={busy}
            onClick={loginWithFirst}
            className="min-h-11 w-full whitespace-normal"
          >
            {busy ? 'Проверка…' : 'Войти с первым Passkey'}
          </Button>
        )}
        {phase === 'done' && (
          <Link
            href="/"
            className="flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-4 text-center text-sm font-medium text-primary-foreground"
          >
            Открыть BillOK
          </Link>
        )}
        <p className="break-words text-center text-xs text-muted-foreground">
          Письмо не является способом входа. Приватный ключ хранится только на устройстве.
        </p>
      </CardContent>
    </Card>
  );
}
