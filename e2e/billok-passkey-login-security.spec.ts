import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { signedQaAssertion } from './passkey-auth';

// An isolated, invitation-verified QA identity. The ONLY usable private key
// is generated at CI seed time in disposable PostgreSQL; no login bypass.
const EMAIL = 'login-probe@mail.ru';
const BASE = process.env.BASE_URL || 'http://localhost:3001';
type ChallengeOptions = { options: { challenge: string; rpId: string; userVerification: string } };

async function newBrowser() {
  return request.newContext({ baseURL: BASE });
}
async function begin(ctx: APIRequestContext) {
  const start = await ctx.post('/api/webauthn/authentication/start', { data: {} });
  expect(start.status()).toBe(200);
  const { options } = (await start.json()) as ChallengeOptions;
  expect(options.userVerification).toBe('required');
  return options;
}
function sign(
  options: ChallengeOptions['options'],
  overrides: {
    origin?: string;
    rpIdForHash?: string;
    userVerified?: boolean;
  } = {},
) {
  return signedQaAssertion({
    email: EMAIL,
    credentialIndex: 0,
    challenge: options.challenge,
    rpId: options.rpId,
    ...overrides,
  });
}
async function noSession(ctx: APIRequestContext) {
  const reply = await ctx.get('/api/auth/session');
  expect(reply.status()).toBe(200);
  const session = (await reply.json()) as { user?: unknown } | null;
  expect(session?.user ?? null).toBeNull();
}

test('signed WebAuthn: origin, RP ID, UV, browser binding, concurrency and single-use Auth.js ticket', async () => {
  test.setTimeout(120_000);
  const browser = await newBrowser();
  const outsider = await newBrowser();
  try {
    // Pure challenge issuance does not authenticate anyone.
    const fromFirst = await begin(browser);
    await noSession(browser);

    // Signed assertion from browser A cannot be replayed by browser B even
    // with a valid real ES256 signature.
    const stolen = await outsider.post('/api/webauthn/authentication/finish', {
      data: sign(fromFirst),
    });
    expect(stolen.status()).toBe(403);
    await noSession(outsider);

    // All negative assertions are cryptographically signed with the correct
    // private key. This tests server RP and UV checking, not just bad crypto.
    for (const overrides of [
      { origin: 'https://evil.example' },
      { rpIdForHash: 'evil.example' },
      { userVerified: false },
    ]) {
      const options = await begin(browser);
      const reply = await browser.post('/api/webauthn/authentication/finish', {
        data: sign(options, overrides),
      });
      expect(reply.status(), 'signed malformed authenticator claim').toBe(403);
      await noSession(browser);
    }

    const wrongSigOptions = await begin(browser);
    const assertion = sign(wrongSigOptions);
    const signature = Buffer.from(assertion.response.signature, 'base64url');
    if (signature.length === 0) throw new Error('Empty ES256 signature fixture');
    signature[signature.length - 1] = signature[signature.length - 1]! ^ 0x01;
    assertion.response.signature = signature.toString('base64url');
    expect((await browser.post('/api/webauthn/authentication/finish', { data: assertion })).status()).toBe(403);

    // Two identical valid responses racing against the same real Postgres
    // challenge: the account/credential lock and atomic UPDATE win once only.
    const options = await begin(browser);
    const valid = sign(options);
    const [one, two] = await Promise.all([
      browser.post('/api/webauthn/authentication/finish', { data: valid }),
      browser.post('/api/webauthn/authentication/finish', { data: valid }),
    ]);
    expect([one.status(), two.status()].sort((a, b) => a - b)).toEqual([200, 403]);
    const winner = one.ok() ? one : two;
    const { loginTicket } = (await winner.json()) as { loginTicket: string };
    expect(loginTicket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await noSession(browser); // signed finish is not an Auth.js session

    // The successfully used challenge cannot mint a second ticket.
    const replay = await browser.post('/api/webauthn/authentication/finish', { data: valid });
    expect(replay.status()).toBe(403);

    const csrf = await browser.get('/api/auth/csrf');
    expect(csrf.status()).toBe(200);
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const loggedIn = await browser.post('/api/auth/callback/passkey', {
      form: { csrfToken, ticket: loginTicket, callbackUrl: BASE + '/dashboard' },
      maxRedirects: 0,
    });
    expect(loggedIn.status()).toBeLessThan(400);
    const current = await browser.get('/api/auth/session');
    expect((await current.json()) as { user?: { email?: string } }).toMatchObject({ user: { email: EMAIL } });

    // No browser, including an outsider, can consume the same ticket twice.
    const secondCsrf = await outsider.get('/api/auth/csrf');
    const other = (await secondCsrf.json()) as { csrfToken: string };
    await outsider.post('/api/auth/callback/passkey', {
      form: { csrfToken: other.csrfToken, ticket: loginTicket, callbackUrl: BASE + '/dashboard' },
      maxRedirects: 0,
    });
    await noSession(outsider);
  } finally {
    await browser.dispose();
    await outsider.dispose();
  }
});
