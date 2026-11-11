/**
 * Disposable CI-only real WebAuthn authentication, no password/session bypass.
 * P-256 keys are paired with public COSE keys in the loopback PostgreSQL seed.
 * The Playwright UI uses Chromium's CTAP2 virtual authenticator. API contexts
 * sign an assertion over a real, browser-bound server challenge.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, request, type BrowserContext, type Page } from '@playwright/test';

type Entry = { id: string; privateKey: string };
type UserFixture = { userHandle: string; credentials: Entry[] };
type Fixtures = Record<string, UserFixture>;

const BASE = process.env.BASE_URL || 'http://localhost:3001';
let cached: Fixtures | undefined;
const nextIndexByEmail = new Map<string, number>();
const sessions = new WeakMap<Page, { cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>>; id: string }>();

function fixture(email: string): UserFixture {
  const path = process.env.BILLOK_QA_PASSKEY_FILE;
  if (!path) throw new Error('Disposable Passkey fixture path missing; never use test keys on production');
  cached ??= JSON.parse(readFileSync(path, 'utf8')) as Fixtures;
  const key = email.split('@', 1)[0]!;
  const value = cached[key];
  if (!value) throw new Error('Unknown disposable Passkey account: ' + key);
  return value;
}

export async function enableVirtualPasskey(page: Page) {
  const existing = sessions.get(page);
  if (existing) return existing;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const state = { cdp, id: authenticatorId };
  sessions.set(page, state);
  return state;
}

export async function installSeedPasskey(page: Page, email: string) {
  const user = fixture(email);
  const { cdp, id } = await enableVirtualPasskey(page);
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId: id });
  const worker = Number(process.env.TEST_WORKER_INDEX || '0') % 2;
  // 1..N/2 for worker 0 and N/2+1..N for worker 1, never reuse a
  // credential between concurrent UI ceremonies (monotone sign counters).
  const serial = nextIndexByEmail.get(email) ?? 1;
  nextIndexByEmail.set(email, serial + 1);
  const offset = Number.parseInt(process.env.BILLOK_QA_PASSKEY_OFFSET || '0', 10);
  if (!Number.isInteger(offset) || offset < 0 || offset > 20) throw new Error('Invalid test credential offset');
  const index = worker * Math.floor((user.credentials.length - 1) / 2) + serial + offset;
  const credential = user.credentials[index];
  if (!credential) throw new Error('Insufficient disposable WebAuthn credentials: ' + email + '/' + index);
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId: id,
    credential: {
      credentialId: Buffer.from(credential.id, 'base64url').toString('base64'),
      isResidentCredential: true,
      rpId: 'localhost',
      privateKey: credential.privateKey,
      signCount: 0,
      userHandle: Buffer.from(user.userHandle, 'base64url').toString('base64'),
    },
  });
}

/** Real browser-side WebAuthn assertion + server-side verification + Auth.js. */
export async function loginWithPasskey(page: Page, email?: string) {
  if (email) await installSeedPasskey(page, email);
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.getByTestId('passkey-login').click();
  await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/, { timeout: 20_000 });
}

/** Real challenge signature; only for the loopback CI PostgreSQL key fixture. */
export async function authedPasskeyContext(email: string) {
  const user = fixture(email);
  const credential = user.credentials[0]!;
  const ctx = await request.newContext({ baseURL: BASE });
  try {
    const start = await ctx.post('/api/webauthn/authentication/start', { data: {} });
    if (!start.ok()) throw new Error('WebAuthn start denied: ' + start.status());
    const { options } = (await start.json()) as { options: { challenge: string; rpId: string } };
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin: BASE,
        crossOrigin: false,
      }),
    );
    const rpIdHash = createHash('sha256').update(options.rpId).digest();
    const counter = Buffer.alloc(4); // legitimate zero-counter multi-device authenticator
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counter]);
    const signedBytes = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]);
    const signature = sign(
      'sha256',
      signedBytes,
      createPrivateKey({
        key: Buffer.from(credential.privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      }),
    );
    const finish = await ctx.post('/api/webauthn/authentication/finish', {
      data: {
        id: credential.id,
        rawId: credential.id,
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
          userHandle: user.userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      },
    });
    if (!finish.ok()) throw new Error('WebAuthn signature rejected: ' + finish.status() + ' ' + (await finish.text()));
    const { loginTicket } = (await finish.json()) as { loginTicket: string };
    const csrf = await ctx.get('/api/auth/csrf');
    if (!csrf.ok()) throw new Error('Auth.js CSRF unavailable');
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const result = await ctx.post('/api/auth/callback/passkey', {
      form: { csrfToken, ticket: loginTicket, callbackUrl: BASE + '/dashboard' },
      maxRedirects: 0,
    });
    if (result.status() >= 400) throw new Error('Auth.js passkey session rejected: ' + result.status());
    return ctx;
  } catch (error) {
    await ctx.dispose();
    throw error;
  }
}
