/**
 * Disposable CI-only real WebAuthn authentication, no password/session bypass.
 * P-256 keys are paired with public COSE keys in the loopback PostgreSQL seed.
 * The Playwright UI uses Chromium's CTAP2 virtual authenticator. API contexts
 * sign an assertion over a real, browser-bound server challenge.
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, request, test, type BrowserContext, type Page } from '@playwright/test';

type Entry = { id: string; privateKey: string; rowId?: string };
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

/** Test-only key metadata from disposable CI PostgreSQL. */
export function qaPasskey(email: string, index: number): Entry {
  const entry = fixture(email).credentials[index];
  if (!entry) throw new Error('Missing disposable Passkey #' + index + ' for ' + email);
  return entry;
}

/** Installs one explicit key for the isolated owner multi-key recovery suite. */
export async function installSelectedQaPasskey(page: Page, email: string, index: number) {
  const user = fixture(email);
  const credential = qaPasskey(email, index);
  const { cdp, id } = await enableVirtualPasskey(page);
  await cdp.send('WebAuthn.clearCredentials', { authenticatorId: id });
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
  // Each CI spec has its own reserved region of the disposable key fixture.
  // Playwright executes multiple tests in separate worker *processes*, and
  // module-level counters alone cannot coordinate distinct processes. The
  // TEST_WORKER_INDEX env is not a Playwright contract and was never supplied.
  // test.info().parallelIndex is the supported stable 0/1 worker slot.
  const info = test.info();
  const parallelIndex = info.parallelIndex;
  if (parallelIndex !== 0 && parallelIndex !== 1) {
    throw new Error('Passkey QA fixture requires exactly the configured two worker slots');
  }
  const allocations = [
    { spec: 'billok-mobile-authenticated.spec.ts', from: 0, to: 0.3 },
    { spec: 'billok-mobile-guest-split.spec.ts', from: 0.3, to: 0.75 },
    { spec: 'billok-mobile-receipt-actions.spec.ts', from: 0.75, to: 0.9 },
    { spec: 'billok-mobile-wide.spec.ts', from: 0.9, to: 0.95 },
    { spec: 'billok-passkey-smoke.spec.ts', from: 0.95, to: 1 },
  ] as const;
  const allocation = allocations.find(({ spec }) => info.file.endsWith('/' + spec));
  if (!allocation) throw new Error('Unallocated disposable Passkey test file: ' + info.file);
  // Credential 0 belongs exclusively to signed API assertions, which always
  // use the standard zero-counter multi-device semantics. Browser CTAP2
  // authenticators increment counters, so MUST have distinct key IDs.
  const usable = user.credentials.length - 1;
  const rangeStart = 1 + Math.floor(usable * allocation.from);
  const rangeEnd = 1 + Math.floor(usable * allocation.to); // exclusive
  const half = Math.floor((rangeEnd - rangeStart) / 2);
  const workerStart = rangeStart + (parallelIndex === 0 ? 0 : half);
  const workerEnd = parallelIndex === 0 ? rangeStart + half : rangeEnd;
  const serialKey = allocation.spec + ':' + parallelIndex + ':' + email;
  const serial = nextIndexByEmail.get(serialKey) ?? 0;
  nextIndexByEmail.set(serialKey, serial + 1);
  const offset = Number.parseInt(process.env.BILLOK_QA_PASSKEY_OFFSET || '0', 10);
  if (!Number.isInteger(offset) || offset < 0 || offset > 20) throw new Error('Invalid test credential offset');
  const index = workerStart + serial + offset;
  if (index >= workerEnd) {
    throw new Error('Exhausted reserved disposable Passkeys for ' + allocation.spec + '/' + email);
  }
  const credential = user.credentials[index]!;
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
export function signedQaAssertion(input: {
  email: string;
  credentialIndex: number;
  challenge: string;
  rpId: string;
  // Negative tests MUST re-sign altered assertions, not just tamper the bytes.
  origin?: string;
  rpIdForHash?: string;
  userVerified?: boolean;
}) {
  const { email, credentialIndex, challenge, rpId, origin = BASE, rpIdForHash = rpId, userVerified = true } = input;
  const user = fixture(email);
  const credential = qaPasskey(email, credentialIndex);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin,
      crossOrigin: false,
    }),
  );
  const rpIdHash = createHash('sha256').update(rpIdForHash).digest();
  // UP=bit0, UV=bit2. Negative test can assert UP only.
  const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([userVerified ? 0x05 : 0x01]), Buffer.alloc(4)]);
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
  return {
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
  };
}

export async function authedPasskeyContext(email: string, credentialIndex = 0) {
  fixture(email);
  const ctx = await request.newContext({ baseURL: BASE });
  try {
    const start = await ctx.post('/api/webauthn/authentication/start', { data: {} });
    if (!start.ok()) throw new Error('WebAuthn start denied: ' + start.status());
    const { options } = (await start.json()) as { options: { challenge: string; rpId: string } };
    const assertion = signedQaAssertion({
      email,
      credentialIndex,
      challenge: options.challenge,
      rpId: options.rpId,
    });
    const finish = await ctx.post('/api/webauthn/authentication/finish', {
      data: assertion,
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
