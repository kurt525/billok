/**
 * Issue #1 6.3.1 — WebAuthn trusted relying-party settings.
 *
 * These values are server-owned. Never derive an RP ID or accepted origin
 * from incoming Host / X-Forwarded-Host / Origin headers. WebAuthn verification
 * must compare signed clientDataJSON.origin to EXACTLY the configured origin.
 */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const WEBAUTHN_PASSKEY_POLICY = {
  attestationType: 'none',
  residentKey: 'required',
  userVerification: 'required',
} as const;

export type WebAuthnRelyingParty = {
  rpId: string;
  origin: string;
  rpName: 'BillOK';
};

type Env = Readonly<Record<string, string | undefined>>;

export function readBillokWebAuthnRelyingParty(env: Env): WebAuthnRelyingParty {
  const rpId = env.BILLOK_WEBAUTHN_RP_ID || 'billok.ru';
  const origin = env.BILLOK_WEBAUTHN_ORIGIN || 'https://billok.ru';
  if (
    rpId.length > 253 ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(rpId) ||
    rpId.startsWith('-') ||
    rpId.includes('..') ||
    rpId.endsWith('-') ||
    rpId.includes('.-') ||
    rpId.includes('-.')
  ) {
    throw new Error('Invalid BillOK WebAuthn RP ID');
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Invalid BillOK WebAuthn origin');
  }

  // URL#origin removes a trailing slash and default ports; exact comparison
  // disallows paths, credentials, query strings and unexpected normalization.
  if (
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Invalid BillOK WebAuthn origin');
  }
  if (parsed.hostname !== rpId && !parsed.hostname.endsWith('.' + rpId)) {
    throw new Error('BillOK WebAuthn origin does not belong to the RP ID');
  }

  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const qaLoopback =
    env.BILLOK_QA_WEBAUTHN_LOOPBACK === '1' &&
    env.BILLOK_QA_FIXTURES === '1' &&
    /^postgres(?:ql)?:\/\/[^/]+@(?:localhost|127\.0\.0\.1):\d+\/billokqa(?:\?.*)?$/u.test(env.DATABASE_URL ?? '') &&
    rpId === 'localhost' &&
    parsed.hostname === 'localhost' &&
    parsed.protocol === 'http:';
  if (
    parsed.protocol !== 'https:' &&
    !(env.NODE_ENV !== 'production' && parsed.protocol === 'http:' && isLoopback) &&
    !qaLoopback
  ) {
    throw new Error('BillOK WebAuthn requires HTTPS (except local development)');
  }
  // The public deployment is ONLY billok.ru. Avoid accidental trust in a
  // different RP ID during setup; test loopback works in non-production.
  if (env.NODE_ENV === 'production' && rpId !== 'billok.ru' && !qaLoopback) {
    throw new Error('BillOK production WebAuthn RP ID must be billok.ru');
  }
  return { rpId, origin, rpName: 'BillOK' };
}

/** Raised browser-test limits are permissible ONLY against the disposable QA DB. */
export function isDisposableWebAuthnQa(env: Env): boolean {
  return (
    env.BILLOK_QA_WEBAUTHN_LOOPBACK === '1' &&
    env.BILLOK_QA_FIXTURES === '1' &&
    env.BILLOK_WEBAUTHN_RP_ID === 'localhost' &&
    (env.BILLOK_WEBAUTHN_ORIGIN ?? '').startsWith('http://localhost:') &&
    /^postgres(?:ql)?:\/\/[^/]+@(?:localhost|127\.0\.0\.1):\d+\/billokqa(?:\?.*)?$/u.test(env.DATABASE_URL ?? '')
  );
}
