import { expect, test, type Page } from '@playwright/test';
import {
  authedPasskeyContext,
  enableVirtualPasskey,
  installSelectedQaPasskey,
  loginWithPasskey,
  qaPasskey,
  signedQaAssertion,
} from './passkey-auth';

// All three owner keys and the owner singleton exist ONLY in disposable QA
// PostgreSQL; WebAuthn assertions are real ES256 signatures, no auth bypass.
const email = 'owner-qa@mail.ru';
const widths = [320, 360, 393, 412, 600, 720] as const;
const expiredToken = 'O'.repeat(43);
const mailbox = process.env.BILLOK_QA_MAILBOX_URL ?? '';

async function findOwnerRecoveryLink(page: Page): Promise<string> {
  let links: string[] = [];
  await expect
    .poll(
      async () => {
        const result = await page.request.get(mailbox + '/messages?to=' + encodeURIComponent(email));
        if (!result.ok()) return 0;
        const response = (await result.json()) as { messages: Array<{ links: string[] }> };
        links = response.messages
          .flatMap((item) => item.links)
          .filter((href) => new URL(href).pathname === '/recover-passkey');
        return links.length;
      },
      { timeout: 25_000, intervals: [250, 500, 1000] },
    )
    .toBeGreaterThan(0);
  return links[0]!;
}

async function expectNoSession(page: Page) {
  const response = await page.request.get('/api/auth/session');
  expect(response.ok()).toBe(true);
  const state = (await response.json()) as { user?: unknown } | null;
  expect(state?.user ?? null).toBeNull();
}

test('owner 3 → 2 → 1 keys, signed revocation, race, email reset, no Magic Link login', async ({ page, browser }) => {
  test.setTimeout(230_000);
  if (!mailbox) throw new Error('Disposable QA SMTP mailbox is required');
  const lost = qaPasskey(email, 0);
  const signer = qaPasskey(email, 1);
  const survivor = qaPasskey(email, 2);
  if (!lost.rowId || !signer.rowId || !survivor.rowId) {
    throw new Error('Owner QA fixture is missing database credential row IDs');
  }
  const oldSession = await authedPasskeyContext(email, 0);
  let twoKeySession: Awaited<ReturnType<typeof authedPasskeyContext>> | null = null;
  let lastKeySession: Awaited<ReturnType<typeof authedPasskeyContext>> | null = null;
  try {
    const initial = await oldSession.get('/api/auth/session');
    expect((await initial.json()) as { user?: { email?: string } }).toMatchObject({ user: { email } });
    await page.context().addCookies((await oldSession.storageState()).cookies);
    await page.goto('/settings', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('passkey-limit')).toContainText('3 из 3');
    await expect(page.getByTestId('passkey-items').getByTestId('passkey-item')).toHaveCount(3);

    // Real mobile widths, enlarged Russian text, short viewport:
    // inspect exactly the card/control that might cross a screen boundary.
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 375 });
      const controls = [page.getByTestId('passkey-inventory'), page.getByTestId('owner-revoke-key-' + lost.rowId)];
      for (const target of controls) {
        await target.scrollIntoViewIfNeeded();
        const box = (await target.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }

    // UI cancellation has no security consequence; lost-key confirmation
    // must be explicitly renewed before a signed assertion is requested.
    await page.getByTestId('owner-revoke-key-' + lost.rowId).click();
    await expect(page.getByTestId('owner-revoke-confirmation')).toBeVisible();
    await page.getByTestId('owner-revoke-cancel').click();
    await expect(page.getByTestId('owner-revoke-confirmation')).toHaveCount(0);
    await page.getByTestId('owner-revoke-key-' + lost.rowId).click();

    // Browser FIDO2 assertion with the surviving second key. The lost
    // first key is NOT installed on this virtual authenticator.
    await installSelectedQaPasskey(page, email, 1);
    await page.getByTestId('owner-revoke-confirm').click();
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/u, { timeout: 30_000 });
    await expect(authedPasskeyContext(email, 0)).rejects.toThrow(/WebAuthn signature rejected: 403/u);
    const invalidSession = await oldSession.get('/api/auth/session');
    expect(((await invalidSession.json()) as { user?: unknown } | null)?.user ?? null).toBeNull();

    // Both surviving registered keys still work; specifically re-login
    // using a different credential from the key that signed the revoke.
    twoKeySession = await authedPasskeyContext(email, 2);
    await page.context().addCookies((await twoKeySession.storageState()).cookies);
    await page.goto('/settings', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('passkey-limit')).toContainText('2 из 3');

    // Two identical, genuinely signed owner-revoke requests racing on real
    // PostgreSQL: precisely one target deletion; the other must get 403.
    const started = await twoKeySession.post('/api/webauthn/owner/revoke/start', {
      data: { targetId: signer.rowId },
    });
    expect(started.status()).toBe(200);
    const { options } = (await started.json()) as {
      options: {
        challenge: string;
        rpId: string;
        allowCredentials?: Array<{ id: string }>;
      };
    };
    expect(options.allowCredentials?.map((entry) => entry.id)).toEqual([survivor.id]);
    const assertion = signedQaAssertion({
      email,
      credentialIndex: 2,
      challenge: options.challenge,
      rpId: options.rpId,
    });
    const [one, two] = await Promise.all([
      twoKeySession.post('/api/webauthn/owner/revoke/finish', { data: assertion }),
      twoKeySession.post('/api/webauthn/owner/revoke/finish', { data: assertion }),
    ]);
    expect([one.status(), two.status()].sort((a, b) => a - b)).toEqual([200, 403]);
    expect(await (one.ok() ? one : two).json()).toEqual({ revoked: true, activeRemaining: 1 });
    await expect(authedPasskeyContext(email, 1)).rejects.toThrow(/WebAuthn signature rejected: 403/u);
    expect(
      ((await (await twoKeySession.get('/api/auth/session')).json()) as { user?: unknown } | null)?.user ?? null,
    ).toBeNull();

    // Last-key protection is enforced at both UI and real API.
    lastKeySession = await authedPasskeyContext(email, 2);
    await page.context().addCookies((await lastKeySession.storageState()).cookies);
    await page.goto('/settings', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('passkey-limit')).toContainText('1 из 3');
    await expect(page.getByText('Последний действующий Passkey отозвать нельзя.', { exact: false })).toBeVisible();
    await expect(page.locator('[data-testid^="owner-revoke-key-"]')).toHaveCount(0);
    const refused = await lastKeySession.post('/api/webauthn/owner/revoke/start', {
      data: { targetId: survivor.rowId },
    });
    expect(refused.status()).toBe(403);

    // Lost ALL owner keys: server must email a one-time enrollment link,
    // NEVER authenticate by email alone, including the owner account.
    const replacement = await browser.newPage({ viewport: { width: 320, height: 650 } });
    try {
      await replacement.goto('/recover-passkey?token=' + expiredToken);
      await replacement.getByTestId('create-recovered-passkey').click();
      await expect(replacement.getByTestId('passkey-recovery-page').getByRole('alert')).toContainText(
        'недействительна или истекла',
      );
      await replacement.getByTestId('request-new-recovery-link').click();
      await replacement.getByTestId('recover-email').fill(email);
      await replacement.getByTestId('request-passkey-recovery').click();
      await expect(replacement.getByRole('status')).toContainText('Если такой аккаунт существует');
      const link = await findOwnerRecoveryLink(replacement);
      await expectNoSession(replacement);
      await enableVirtualPasskey(replacement);
      await replacement.goto(link, { waitUntil: 'networkidle' });
      await replacement.getByTestId('create-recovered-passkey').click();
      await expect(replacement.getByRole('status')).toContainText('Новый Passkey создан', { timeout: 30_000 });
      await expectNoSession(replacement);
      await expect(authedPasskeyContext(email, 2)).rejects.toThrow(/WebAuthn signature rejected: 403/u);
      const replay = await replacement.request.post('/api/webauthn/recovery/start', {
        data: { token: new URL(link).searchParams.get('token') },
      });
      expect(replay.status()).toBe(403);
      expect(
        ((await (await lastKeySession.get('/api/auth/session')).json()) as { user?: unknown } | null)?.user ?? null,
      ).toBeNull();
      // The replacement authenticator has the only valid credential.
      await loginWithPasskey(replacement);
      await expect(replacement.getByRole('heading', { name: 'Главная' })).toBeVisible();
      await replacement.goto('/settings');
      await expect(replacement.getByTestId('passkey-limit')).toContainText('1 из 3');
    } finally {
      await replacement.close();
    }
  } finally {
    await oldSession.dispose();
    await twoKeySession?.dispose();
    await lastKeySession?.dispose();
  }
});
