'use client';

import { useEffect, useRef, useState } from 'react';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Pending = { email: string; expiresAt: string };
type Status = { allowed: boolean; owner: boolean; pending: Pending | null };
class EmailChangeApiError extends Error {}
async function post<T>(action: string, data: object = {}): Promise<T> {
  const response = await fetch('/api/webauthn/email-change/' + action, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok)
    throw new EmailChangeApiError(typeof result.error === 'string' ? result.error : 'Не удалось выполнить операцию.');
  return result as T;
}
const buttonClass = 'min-h-11 min-w-11 h-auto max-w-full whitespace-normal [overflow-wrap:anywhere]';

export function EmailChangeSettings() {
  const t = useTranslations('settings.emailChange');
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [completed, setCompleted] = useState(false);
  const token = useRef<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setStatus(await post<Status>('status'));
      setError('');
    } catch {
      setStatus(null);
      setError(t('statusError'));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    // Remove fragment immediately, before any subsequent navigation. It is
    // kept ONLY in memory, never in sessionStorage/localStorage or a URL query.
    function readFragment() {
      const match = /^#email-change=([A-Za-z0-9_-]{43})$/u.exec(window.location.hash);
      if (match) {
        token.current = match[1]!;
        setHasToken(true);
        history.replaceState(history.state, '', location.pathname + location.search);
      }
    }
    readFragment();
    window.addEventListener('hashchange', readFragment);
    let alive = true;
    void post<Status>('status')
      .then(
        (value) => {
          if (alive) setStatus(value);
        },
        () => {
          if (alive) setError(t('statusError'));
        },
      )
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      window.removeEventListener('hashchange', readFragment);
    };
  }, [t]);

  async function begin(address: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>('start', { email: address });
      const response = await startAuthentication({ optionsJSON: options });
      const result = await post<Pending & { delivered: boolean }>('approve', { response });
      setStatus({ allowed: true, owner: false, pending: { email: result.email, expiresAt: result.expiresAt } });
      token.current = null;
      setHasToken(false);
      setExpanded(false);
      setNotice(result.delivered ? t('sent') : t('deliveryFailed'));
    } catch (error) {
      setError(error instanceof EmailChangeApiError ? error.message : t('passkeyError'));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError('');
    try {
      await post('cancel');
      setStatus({ allowed: true, owner: false, pending: null });
      token.current = null;
      setHasToken(false);
      setExpanded(false);
      setEmail('');
      setNotice(t('cancelled'));
    } catch (error) {
      setError(error instanceof EmailChangeApiError ? error.message : t('statusError'));
    } finally {
      setBusy(false);
    }
  }
  async function complete() {
    if (!token.current) return;
    setBusy(true);
    setError('');
    try {
      await post('complete', { token: token.current });
      token.current = null;
      setHasToken(false);
      setCompleted(true);
      setStatus(null);
      // The server already invalidated all older sessions. Never silently
      // retain or renew the previous cookie after the security-version rotation.
    } catch (error) {
      setError(error instanceof EmailChangeApiError ? error.message : t('statusError'));
    } finally {
      setBusy(false);
    }
  }
  if (completed)
    return (
      <section className="mt-4 min-w-0 space-y-3 border-t pt-4" data-testid="email-change-completed">
        <p role="status" className="text-sm [overflow-wrap:anywhere]">
          {t('completed')}
        </p>
        <Button className={buttonClass} onClick={() => void signOut({ redirectTo: '/login' })}>
          {t('loginAgain')}
        </Button>
      </section>
    );
  if (status?.owner)
    return (
      <p className="mt-3 text-sm text-muted-foreground" data-testid="email-change-owner-blocked">
        {t('ownerBlocked')}
      </p>
    );
  return (
    <section
      className="mt-4 min-w-0 space-y-3 border-t pt-4 [overflow-wrap:anywhere]"
      data-testid="email-change-section"
    >
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('loading')}
        </p>
      ) : !status?.allowed ? (
        <Button type="button" className={buttonClass} variant="outline" onClick={() => void refresh()}>
          {t('retry')}
        </Button>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
          {status.pending && (
            <div className="space-y-2 rounded-md border p-3" data-testid="email-change-pending">
              <p className="text-sm font-medium">{t('pending')}</p>
              <p className="text-sm [overflow-wrap:anywhere]">{status.pending.email}</p>
              <p className="text-xs text-muted-foreground">
                {t('expires', { date: new Date(status.pending.expiresAt).toLocaleString('ru-RU') })}
              </p>
              {hasToken && (
                <Button
                  disabled={busy}
                  className={buttonClass}
                  onClick={() => void complete()}
                  data-testid="email-change-confirm"
                >
                  {t('confirm')}
                </Button>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  className={buttonClass}
                  variant="outline"
                  onClick={() => void begin(status.pending!.email)}
                >
                  {t('resend')}
                </Button>
                <Button disabled={busy} className={buttonClass} variant="outline" onClick={() => void cancel()}>
                  {t('cancel')}
                </Button>
              </div>
            </div>
          )}
          {hasToken && !status.pending && (
            <p role="alert" className="text-sm text-destructive">
              {t('wrongSession')}
            </p>
          )}
          {!expanded ? (
            <Button
              disabled={busy}
              className={buttonClass}
              variant="outline"
              data-testid="email-change-open"
              onClick={() => {
                setExpanded(true);
                setEmail('');
                setError('');
              }}
            >
              {t('open')}
            </Button>
          ) : (
            <form
              className="min-w-0 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void begin(email);
              }}
            >
              <Label htmlFor="new-account-email">{t('newEmail')}</Label>
              <Input
                id="new-account-email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={254}
                className="min-h-11 min-w-0 text-base"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" className={buttonClass} disabled={busy || !email}>
                  {busy ? t('busy') : t('passkey')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => setExpanded(false)}
                >
                  {t('close')}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
