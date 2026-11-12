import { expect, request, test, type Page } from '@playwright/test';
import { authedPasskeyContext, enableVirtualPasskey, loginWithPasskey } from './passkey-auth';

// Disposable local PostgreSQL + TLS SMTP + real browser WebAuthn only.
// No test HTTP endpoint may create credentials, sessions or recovery tokens.
const mailbox = process.env.BILLOK_QA_MAILBOX_URL ?? '';
const email = 'recovery@mail.ru';
const expiredToken = 'R'.repeat(43);
const validToken = 'q'.repeat(43);
const widths = [320, 360, 393, 412, 600, 720] as const;

async function emailRecoveryLink(page: Page): Promise<string> {
  let links: string[] = [];
  await expect
    .poll(
      async () => {
        const response = await page.request.get(mailbox + '/messages?to=' + encodeURIComponent(email));
        if (!response.ok()) return 0;
        const data = (await response.json()) as { messages: Array<{ links: string[] }> };
        links = data.messages
          .flatMap((item) => item.links)
          .filter((link) => new URL(link).pathname === '/recover-passkey');
        return links.length;
      },
      { timeout: 20_000, intervals: [200, 350, 750, 1300] },
    )
    .toBeGreaterThan(0);
  return links[0]!;
}

test('real email recovery rotates one Passkey and old session; replay and expired token denied', async ({ page }) => {
  test.setTimeout(150_000);
  if (!mailbox) throw new Error('Disposable QA mailbox is required for recovery acceptance');
  await page.setViewportSize({ width: 360, height: 740 });
  const oldSession = await authedPasskeyContext(email);
  try {
    const before = await oldSession.get('/api/auth/session');
    expect(before.ok()).toBe(true);
    expect((await before.json()) as { user?: { email?: string } }).toMatchObject({ user: { email } });

    // Signed WebAuthn bootstrap is *not* a replacement for email confirmation.
    // Even with a valid token shape, a stale database link is rejected.
    await page.goto('/recover-passkey?token=' + expiredToken);
    await page.getByTestId('create-recovered-passkey').click();
    await expect(page.getByTestId('passkey-recovery-page').getByRole('alert')).toContainText(
      'Ссылка восстановления недействительна или истекла',
    );
    await expect(page.getByTestId('request-new-recovery-link')).toBeVisible();
    await page.getByTestId('request-new-recovery-link').click();
    await expect(page.getByTestId('recover-email')).toBeVisible();

    await page.getByTestId('recover-email').fill(email);
    await page.getByTestId('request-passkey-recovery').click();
    await expect(page.getByRole('status')).toContainText('Если такой аккаунт существует');
    const link = await emailRecoveryLink(page);
    const token = new URL(link).searchParams.get('token')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    await enableVirtualPasskey(page);
    await page.goto(link, { waitUntil: 'networkidle' });
    const foreignBrowser = await request.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3001' });
    let raceStatuses: number[] = [];
    let crossBrowserDenied = false;
    // Intercept only the browser's genuine attestation submission: relay its
    // signed bytes to the real API twice concurrently. No mock finish response.
    await page.route('**/api/webauthn/recovery/finish', async (route) => {
      const payload = route.request().postData() ?? '{}';
      const cookie = route.request().headers()['cookie'] ?? '';
      const outsider = await foreignBrowser.post('/api/webauthn/recovery/finish', {
        data: payload,
        headers: { 'content-type': 'application/json' },
      });
      crossBrowserDenied = outsider.status() === 403;
      const headers = { 'content-type': 'application/json', cookie };
      const [first, second] = await Promise.all([
        foreignBrowser.post('/api/webauthn/recovery/finish', { data: payload, headers }),
        foreignBrowser.post('/api/webauthn/recovery/finish', { data: payload, headers }),
      ]);
      raceStatuses = [first.status(), second.status()].sort((a, b) => a - b);
      const winner = first.ok() ? first : second;
      await route.fulfill({
        status: winner.status(),
        contentType: 'application/json',
        body: await winner.text(),
      });
    });
    let starts = 0;
    let finishes = 0;
    let passwordOrMagicLogin = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/webauthn/recovery/start')) starts++;
      if (request.url().includes('/api/webauthn/recovery/finish')) finishes++;
      if (request.url().includes('/api/auth/callback')) passwordOrMagicLogin++;
    });
    // Two touch events in the same JS turn must result in ONE cryptographic
    // registration ceremony and exactly one account-state rotation.
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="create-recovered-passkey"]') as HTMLButtonElement;
      btn.click();
      btn.click();
    });
    await expect(page.getByRole('status')).toContainText('Новый Passkey создан', { timeout: 30_000 });
    expect(starts).toBe(1);
    expect(finishes).toBe(1);
    expect(passwordOrMagicLogin).toBe(0);
    expect(crossBrowserDenied).toBe(true);
    expect(raceStatuses).toEqual([200, 403]); // one success, one replay
    await foreignBrowser.dispose();
    await expect(page).toHaveURL(/\/recover-passkey$/u);
    await expect(page.getByRole('link', { name: 'Войти с новым Passkey' })).toBeVisible();

    // Email and WebAuthn registration must NEVER silently create an Auth.js session.
    const noLogin = await page.request.get('/api/auth/session');
    expect((await noLogin.json()) as { user?: unknown }).not.toHaveProperty('user');

    // Previously minted JWTs immediately become unusable.
    const prior = await oldSession.get('/api/auth/session');
    expect((await prior.json()) as { user?: unknown }).not.toHaveProperty('user');

    // Old credential is revoked, even with a valid P-256 signature.
    await expect(authedPasskeyContext(email)).rejects.toThrow(/WebAuthn signature rejected: 403/u);

    // The one-time link is consumed and cannot open another ceremony.
    const reused = await page.request.post('/api/webauthn/recovery/start', { data: { token } });
    expect(reused.status()).toBe(403);

    // A separate, ordinary WebAuthn login with the NEW device is required.
    await loginWithPasskey(page);
    await expect(page.getByRole('heading', { name: 'Главная' })).toBeVisible();
  } finally {
    await oldSession.dispose();
  }
});

test('mobile recovery stays accessible at six widths with long Russian messages and keyboard', async ({ page }) => {
  await page.goto('/recover-passkey');
  for (const width of widths) {
    await page.setViewportSize({ width, height: 360 });
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    const input = page.getByTestId('recover-email');
    const send = page.getByTestId('request-passkey-recovery');
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeInViewport();
    expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport();
    const rect = (await send.boundingBox())!;
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width + 1);
    const size = await page.evaluate(() => ({ screen: innerWidth, content: document.documentElement.scrollWidth }));
    expect(size).toEqual({ screen: width, content: width });
  }

  // The TOKEN state, including a long Russian expiration warning and the
  // action for requesting another email, needs the same mobile audit.
  await page.route('**/api/webauthn/recovery/start', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: '{"error":"Недействительная ссылка восстановления."}',
    }),
  );
  await page.goto('/recover-passkey?token=' + validToken);
  await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
  await page.getByTestId('create-recovered-passkey').click();
  const alert = page.getByTestId('passkey-recovery-page').getByRole('alert');
  await expect(alert).toContainText('Ссылка восстановления недействительна или истекла');
  for (const width of widths) {
    await page.setViewportSize({ width, height: 360 });
    for (const item of [
      alert,
      page.getByTestId('create-recovered-passkey'),
      page.getByTestId('request-new-recovery-link'),
    ]) {
      await item.scrollIntoViewIfNeeded();
      await expect(item).toBeInViewport();
      const box = (await item.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  }
});

test('double-tap email request sends only one operation; network failure can be retried', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/webauthn/recovery/request', async (route) => {
    attempts++;
    await new Promise((done) => setTimeout(done, 140));
    if (attempts === 1) await route.abort('failed');
    else await route.fulfill({ status: 202, contentType: 'application/json', body: '{"requested":true}' });
  });
  await page.goto('/recover-passkey');
  await page.getByTestId('recover-email').fill('sample@mail.ru');
  await page.evaluate(() => {
    const button = document.querySelector('[data-testid="request-passkey-recovery"]') as HTMLButtonElement;
    button.click();
    button.click();
  });
  await expect(page.getByTestId('passkey-recovery-page').getByRole('alert')).toContainText('Проверьте соединение');
  expect(attempts).toBe(1);
  await page.getByTestId('request-passkey-recovery').click();
  await expect(page.getByRole('status')).toContainText('Если такой аккаунт существует');
  expect(attempts).toBe(2);
});

test('cancelled WebAuthn ceremony shows Russian retry instruction and no recovery finish call', async ({ page }) => {
  let startCalls = 0;
  let finishCalls = 0;
  await page.route('**/api/webauthn/recovery/start', async (route) => {
    startCalls++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        options: {
          rp: { name: 'BillOK', id: 'localhost' },
          challenge: validToken,
          user: { id: 'c'.repeat(43), name: email, displayName: 'QA' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          timeout: 300_000,
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        },
      }),
    });
  });
  await page.route('**/api/webauthn/recovery/finish', (route) => {
    finishCalls++;
    return route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/recover-passkey?token=' + validToken);
  await page.evaluate(() => {
    Object.defineProperty(navigator.credentials, 'create', {
      configurable: true,
      value: async () => {
        throw new DOMException('Cancelled by QA', 'NotAllowedError');
      },
    });
  });
  await page.getByTestId('create-recovered-passkey').click();
  await expect(page.getByTestId('passkey-recovery-page').getByRole('alert')).toContainText('Создание Passkey отменено');
  expect(startCalls).toBe(1);
  expect(finishCalls).toBe(0);
  await page.getByTestId('create-recovered-passkey').click();
  await expect(page.getByTestId('passkey-recovery-page').getByRole('alert')).toContainText('Повторите попытку');
  expect(startCalls).toBe(2);
  expect(finishCalls).toBe(0);
});

test('browser without WebAuthn gives actionable Russian error and never calls recovery API', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: undefined });
  });
  let starts = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/webauthn/recovery/start')) starts++;
  });
  await page.goto('/recover-passkey?token=' + validToken);
  await page.getByTestId('create-recovered-passkey').click();
  await expect(page.getByTestId('passkey-recovery-page').getByRole('alert')).toContainText('не поддерживает Passkey');
  expect(starts).toBe(0);
});
