/**
 * Issue #1 / 5.12: optional, explicitly consented Web Push for guests.
 * Never store subscription endpoints or crypto keys in a public receipt.
 * If not configured or unsupported the 5.11 server-backed unread notice
 * continues to work independently.
 */
import { createHash } from 'node:crypto';

export type GuestWebPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  // Server-only binding: replacing/rotating the guest's personal token
  // immediately invalidates old device endpoints without needing changes
  // to unrelated guest personal-link workflows.
  tokenBinding?: string;
};

export const MAX_GUEST_PUSH_SUBSCRIPTIONS = 4;

const endpointHosts = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

/** Reject local/IP/intranet endpoints to avoid sending authenticated push POSTs to arbitrary hosts. */
export function validGuestPushEndpoint(raw: string): boolean {
  if (!raw || raw.length > 2048) return false;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === '443') &&
      endpointHosts.some((host) => hostname === host || hostname.endsWith('.' + host))
    );
  } catch {
    return false;
  }
}

export function validGuestPushSubscription(value: unknown): value is GuestWebPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GuestWebPushSubscription>;
  if (typeof candidate.endpoint !== 'string' || !validGuestPushEndpoint(candidate.endpoint)) return false;
  if (!candidate.keys || typeof candidate.keys !== 'object') return false;
  const { p256dh, auth } = candidate.keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return false;
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return false;
  const publicKey = Buffer.from(p256dh, 'base64url');
  return publicKey.length === 65 && publicKey[0] === 4 && Buffer.from(auth, 'base64url').length === 16;
}

export function validStoredGuestPushSubscriptions(value: unknown): GuestWebPushSubscription[] {
  if (!Array.isArray(value)) return [];
  return value.filter(validGuestPushSubscription).slice(0, MAX_GUEST_PUSH_SUBSCRIPTIONS);
}

/** A rotated personal-link credential must not receive old device pushes. */
export function guestPushTokenBinding(personToken: string): string {
  return createHash('sha256').update(personToken).digest('base64url');
}

export function activeGuestPushSubscriptions(value: unknown, currentPersonToken: string): GuestWebPushSubscription[] {
  const binding = guestPushTokenBinding(currentPersonToken);
  return validStoredGuestPushSubscriptions(value).filter((subscription) => subscription.tokenBinding === binding);
}

function vapidSettings() {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = process.env.WEB_PUSH_VAPID_SUBJECT?.trim() || 'mailto:noreply@billok.ru';
  if (!/^[A-Za-z0-9_-]+$/.test(publicKey) || Buffer.from(publicKey, 'base64url').length !== 65) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(privateKey) || Buffer.from(privateKey, 'base64url').length !== 32) return null;
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\/[^\s]+$/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/** Public VAPID key; private key never reaches the browser. */
export function guestPushPublicKey(): string | null {
  return vapidSettings()?.publicKey ?? null;
}

/** Send only AFTER transaction commit. Never let a push outage undo a saved confirmation. */
export async function sendGuestReceiptPush(
  subscriptions: readonly GuestWebPushSubscription[],
  receiptHref: string,
  notificationId: string,
  kind: 'confirmed' | 'cancelled' = 'confirmed',
): Promise<void> {
  const credentials = vapidSettings();
  if (!credentials || !/^\/split\/[A-Za-z0-9_-]+\/claim$/.test(receiptHref)) return;
  const targets = subscriptions.filter(validGuestPushSubscription).slice(0, MAX_GUEST_PUSH_SUBSCRIPTIONS);
  if (targets.length === 0) return;
  const { default: webpush } = await import('web-push');
  webpush.setVapidDetails(credentials.subject, credentials.publicKey, credentials.privateKey);
  // No payer phone number, person token, amount or name on a locked device.
  const payload = JSON.stringify({
    title: 'BillOK',
    kind,
    // Generic text only: no receiver phone, bank, amount, identity or token.
    body:
      kind === 'cancelled'
        ? 'Подтверждение поступления отменено. Откройте чек в BillOK.'
        : 'Поступление перевода подтверждено. Откройте чек в BillOK.',
    url: receiptHref,
    tag: 'billok-receipt-' + notificationId,
  });
  await Promise.allSettled(
    targets.map((subscription) =>
      webpush.sendNotification(subscription, payload, {
        TTL: 3 * 24 * 60 * 60,
        timeout: 3500,
      }),
    ),
  );
}
