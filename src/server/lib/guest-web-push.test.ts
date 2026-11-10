import { describe, expect, it } from 'vitest';
import {
  MAX_GUEST_PUSH_SUBSCRIPTIONS,
  activeGuestPushSubscriptions,
  guestPushPublicKey,
  guestPushTokenBinding,
  validGuestPushEndpoint,
  validGuestPushSubscription,
  validStoredGuestPushSubscriptions,
} from './guest-web-push';

const validSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-token',
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
    auth: Buffer.alloc(16, 2).toString('base64url'),
  },
};

describe('5.12 guest Web Push safety and fallback', () => {
  it('allows public push gateways but rejects intranet, URLs with credentials and lookalike domains', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/a',
      'https://updates.push.services.mozilla.com/wpush/v2/test',
      'https://web.push.apple.com/QAB',
      'https://wns2-sg2p.notify.windows.com/?token=example',
    ]) {
      expect(validGuestPushEndpoint(endpoint), endpoint).toBe(true);
    }
    for (const endpoint of [
      'http://fcm.googleapis.com/send/a',
      'http://127.0.0.1:3000/api/admin',
      'https://127.0.0.1/internal',
      'https://localhost/private',
      'https://fcm.googleapis.com.attacker.example/fcm/send',
      'https://user:pass@fcm.googleapis.com/endpoint',
      'https://fcm.googleapis.com:444/endpoint',
      'https://fcm.googleapis.com/endpoint#fragment',
      'https://example.org/push',
    ]) {
      expect(validGuestPushEndpoint(endpoint), endpoint).toBe(false);
    }
  });

  it('bounds encrypted subscription credentials and strips malformed entries', () => {
    expect(validGuestPushSubscription(validSubscription)).toBe(true);
    expect(
      validGuestPushSubscription({ ...validSubscription, keys: { ...validSubscription.keys, auth: 'wrong' } }),
    ).toBe(false);
    expect(validGuestPushSubscription({ ...validSubscription, endpoint: 'https://localhost/secret' })).toBe(false);
    expect(validStoredGuestPushSubscriptions([null, ...Array(9).fill(validSubscription)])).toHaveLength(
      MAX_GUEST_PUSH_SUBSCRIPTIONS,
    );
  });

  it('a rotated guest personal credential cannot receive notifications on a prior device', () => {
    const oldPersonToken = '11111111-1111-4111-8111-111111111111';
    const newPersonToken = '22222222-2222-4222-8222-222222222222';
    const bound = { ...validSubscription, tokenBinding: guestPushTokenBinding(oldPersonToken) };
    expect(activeGuestPushSubscriptions([bound], oldPersonToken)).toEqual([bound]);
    expect(activeGuestPushSubscriptions([bound], newPersonToken)).toEqual([]);
    expect(activeGuestPushSubscriptions([validSubscription], oldPersonToken)).toEqual([]);
  });

  it('does not advertise unconfigured Web Push while on-site unread notices still work', () => {
    const oldPublic = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const oldPrivate = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    try {
      delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
      delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
      expect(guestPushPublicKey()).toBeNull();
    } finally {
      if (oldPublic === undefined) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
      else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = oldPublic;
      if (oldPrivate === undefined) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
      else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = oldPrivate;
    }
  });
});
