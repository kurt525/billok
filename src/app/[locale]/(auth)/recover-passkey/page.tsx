'use client';

import { Suspense, useRef, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useSearchParams } from 'next/navigation';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { KeyRound } from 'lucide-react';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

class RecoveryHttpError extends Error {
  constructor(readonly status: number) {
    super('Recovery HTTP request failed');
  }
}

function recoveryFailure(error: unknown): string {
  if (error instanceof RecoveryHttpError && error.status === 403) {
    return 'Ссылка восстановления недействительна или истекла. Запросите новое письмо.';
  }
  const candidate =
    typeof error === 'object' && error !== null ? (error as { name?: unknown; code?: unknown; cause?: unknown }) : null;
  const cause =
    typeof candidate?.cause === 'object' && candidate.cause !== null ? (candidate.cause as { name?: unknown }) : null;
  if (
    candidate?.name === 'NotAllowedError' ||
    candidate?.code === 'ERROR_CEREMONY_ABORTED' ||
    cause?.name === 'NotAllowedError'
  ) {
    // @simplewebauthn/browser wraps a native NotAllowedError in WebAuthnError.
    return 'Создание Passkey отменено или не подтверждено на устройстве. Повторите попытку.';
  }
  return 'Не удалось создать Passkey. Проверьте соединение и повторите попытку.';
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new RecoveryHttpError(response.status);
  return response.json() as Promise<T>;
}

export default function RecoverPasskeyPage() {
  return (
    <Suspense>
      <RecoveryForm />
    </Suspense>
  );
}

function RecoveryForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const validToken = TOKEN_PATTERN.test(token);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [requestAgain, setRequestAgain] = useState(false);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function requestEmail(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || !email.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await postJson<{ requested: true }>('/api/webauthn/recovery/request', { email: email.trim() });
      setNotice('Если такой аккаунт существует, письмо с восстановлением отправлено. Проверьте почту.');
    } catch {
      setError('Не удалось отправить запрос. Проверьте соединение и повторите попытку.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function createReplacementKey() {
    if (inFlight.current || !validToken || requestAgain) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (typeof window === 'undefined' || !window.PublicKeyCredential) {
        setError('Это устройство или браузер не поддерживает Passkey. Используйте другое устройство.');
        return;
      }
      const { options } = await postJson<{ options: PublicKeyCredentialCreationOptionsJSON }>(
        '/api/webauthn/recovery/start',
        { token },
      );
      const credential = await startRegistration({ optionsJSON: options });
      await postJson<{ recovered: true }>('/api/webauthn/recovery/finish', { token, credential });
      window.history.replaceState(null, '', window.location.pathname);
      setDone(true);
      setNotice('Новый Passkey создан. Старый ключ и прежние сеансы отозваны. Теперь войдите с новым ключом.');
    } catch (failure) {
      setError(recoveryFailure(failure));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Card data-testid="passkey-recovery-page" className="min-w-0 border-primary/10 shadow-lg">
      <CardHeader>
        <div className="mb-2 flex justify-center">
          <KeyRound className="size-8 text-primary" aria-hidden="true" />
        </div>
        <CardTitle className="text-center text-xl">Восстановление ключа доступа</CardTitle>
        <CardDescription className="text-center">
          Электронная почта разрешает создать новый Passkey, но не выполняет вход в BillOK.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        {notice && (
          <p role="status" className="break-words rounded-lg bg-muted p-3 text-sm">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="break-words rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {done ? (
          <Link
            href="/login"
            className="flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Войти с новым Passkey
          </Link>
        ) : validToken && !requestAgain ? (
          <div className="min-w-0 space-y-3">
            <Button
              type="button"
              data-testid="create-recovered-passkey"
              disabled={busy}
              onClick={() => void createReplacementKey()}
              className="min-h-11 w-full whitespace-normal"
            >
              {busy ? 'Проверка…' : 'Создать новый Passkey'}
            </Button>
            <Button
              variant="link"
              type="button"
              data-testid="request-new-recovery-link"
              disabled={busy}
              className="min-h-11 w-full whitespace-normal"
              onClick={() => {
                setRequestAgain(true);
                setError('');
              }}
            >
              Запросить новую ссылку
            </Button>
          </div>
        ) : (
          <form onSubmit={(event) => void requestEmail(event)} className="space-y-4">
            <label htmlFor="recover-email" className="block text-sm font-medium">
              Электронная почта аккаунта
            </label>
            <Input
              id="recover-email"
              data-testid="recover-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="example@mail.ru"
              required
              maxLength={254}
              className="min-h-11"
            />
            <Button
              type="submit"
              data-testid="request-passkey-recovery"
              disabled={busy}
              className="min-h-11 w-full whitespace-normal"
            >
              {busy ? 'Отправка…' : 'Получить письмо для восстановления'}
            </Button>
          </form>
        )}
        <p className="text-center text-xs text-muted-foreground">
          Ссылка действует 30 минут. Количество восстановлений не ограничено, но частота запросов защищена от
          злоупотреблений.
        </p>
        {!done && (
          <Link href="/login" className="flex min-h-11 items-center justify-center text-sm underline">
            Вернуться ко входу
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
