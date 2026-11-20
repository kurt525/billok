'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';

function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Convert the PUBLIC VAPID key without exposing the server's private key. */
function applicationServerKey(publicKey: string): ArrayBuffer {
  const normalized = publicKey.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) view[index] = binary.charCodeAt(index);
  return buffer;
}

/** Permission prompt is NEVER triggered by page load or polling; click only. */
export function GuestWebPushControls({
  token,
  personId,
  personToken,
}: {
  token: string;
  personId: string;
  personToken: string;
}) {
  const t = useTranslations('split.claim');
  const config = trpc.guest.getGuestPushConfig.useQuery(undefined, { staleTime: 60_000 });
  const subscribe = trpc.guest.subscribeMyGuestPush.useMutation();
  const unsubscribe = trpc.guest.unsubscribeMyGuestPush.useMutation();
  const readStatus = trpc.guest.getMyGuestPushStatus.useMutation();
  const readStatusAsync = readStatus.mutateAsync;
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Read browser capabilities after hydration; do not synchronously cause
    // cascading state updates from the effect setup.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const available = pushSupported();
      setSupported(available);
      if (available) setPermission(Notification.permission);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const publicKey = config.data?.publicKey ?? null;

  useEffect(() => {
    if (!supported || !publicKey || permission !== 'granted') return;
    let cancelled = false;
    void navigator.serviceWorker
      .getRegistration('/billok-push-sw.js')
      .then((registration) => registration?.pushManager.getSubscription())
      .then((existing) => {
        if (!existing || cancelled) return;
        return readStatusAsync({ token, personId, personToken, endpoint: existing.endpoint }).then((result) => {
          if (!cancelled) setSubscribed(result.subscribed);
        });
      })
      .catch(() => {
        // The always-available BillOK unread inbox is the fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [supported, publicKey, permission, personId, personToken, token, readStatusAsync]);

  async function enablePush() {
    if (!publicKey || !pushSupported() || busy) return;
    setBusy(true);
    try {
      // Begin the browser permission request from THIS click, never in an effect.
      const permissionResult = Notification.requestPermission();
      const granted = await permissionResult;
      setPermission(granted);
      if (granted !== 'granted') return;
      const registration = await navigator.serviceWorker.register('/billok-push-sw.js', { scope: '/' });
      const existing = await registration.pushManager.getSubscription();
      const fresh =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        }));
      const payload = fresh.toJSON();
      if (!payload.endpoint || !payload.keys?.p256dh || !payload.keys?.auth) {
        throw new Error('missing encrypted push keys');
      }
      await subscribe.mutateAsync({
        token,
        personId,
        personToken,
        subscription: {
          endpoint: payload.endpoint,
          keys: { p256dh: payload.keys.p256dh, auth: payload.keys.auth },
        },
      });
      setSubscribed(true);
      toast.success(t('pushEnabled'));
    } catch {
      toast.error(t('pushFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function disablePush() {
    if (busy || !supported) return;
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/billok-push-sw.js');
      const current = await registration?.pushManager.getSubscription();
      if (current) {
        await unsubscribe.mutateAsync({ token, personId, personToken, endpoint: current.endpoint });
      }
      // The browser subscription is shared by different receipts on this
      // origin. Only revoke the CURRENT receipt's authorized endpoint.
      setSubscribed(false);
      toast.success(t('pushDisabled'));
    } catch {
      toast.error(t('pushFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="min-w-0 space-y-2 rounded-lg border border-border p-3"
      data-testid="guest-web-push-controls"
      aria-label={t('pushTitle')}
    >
      <h3 className="text-sm font-semibold">{t('pushTitle')}</h3>
      <p className="text-xs text-muted-foreground">{t('pushFallback')}</p>
      {!publicKey ? (
        <p className="text-xs text-muted-foreground" data-testid="guest-web-push-unavailable">
          {t('pushServerUnavailable')}
        </p>
      ) : !supported ? (
        <p className="text-xs text-muted-foreground" data-testid="guest-web-push-unsupported">
          {t('pushBrowserUnsupported')}
        </p>
      ) : permission === 'denied' ? (
        <p className="text-xs text-muted-foreground" data-testid="guest-web-push-denied">
          {t('pushPermissionDenied')}
        </p>
      ) : (
        <>
          {subscribed && (
            <p
              className="text-xs font-semibold text-green-700 dark:text-green-400"
              data-testid="guest-web-push-enabled"
            >
              {t('pushEnabled')}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full whitespace-normal [overflow-wrap:anywhere]"
            onClick={subscribed ? disablePush : enablePush}
            disabled={busy || subscribe.isPending || unsubscribe.isPending}
            data-testid={subscribed ? 'guest-web-push-disable' : 'guest-web-push-enable'}
          >
            {subscribed ? t('pushDisable') : t('pushEnable')}
          </Button>
        </>
      )}
    </section>
  );
}
