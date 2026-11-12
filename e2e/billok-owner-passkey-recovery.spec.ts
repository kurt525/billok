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

test('owner mobile Passkey lifecycle: signed rename, revoke, email reset, add 2/3, no bypass', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
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
    await expect(page.getByTestId('owner-passkey-full')).toBeVisible();
    // Issue #1 6.11: inspect the separate owner-only registered-user page
    // WITHOUT spawning a second test with this singleton owner (avoids races
    // with the destructive Passkey recovery lifecycle below).
    const managedEmail = 'owner-users-target@mail.ru';
    const managedSession = await authedPasskeyContext(managedEmail, 0);
    try {
      await page.goto('/admin', { waitUntil: 'networkidle' });
      await expect(page.getByTestId('owner-users-nav')).toBeVisible();
      await page.getByTestId('owner-users-nav').click();
      await expect(page.getByTestId('owner-users-page')).toBeVisible();
      await expect(page.getByTestId('owner-users-list')).toBeVisible();
      await page.getByTestId('owner-users-search').fill(managedEmail);
      const targetCard = page.locator('[data-testid^="owner-user-"]').filter({ hasText: managedEmail });
      await expect(targetCard).toHaveCount(1);
      await expect(page.getByTestId('owner-users-count')).toContainText('1');
      for (const width of widths) {
        await page.setViewportSize({ width, height: 410 });
        await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
        for (const element of [
          page.getByTestId('owner-users-page'),
          page.getByTestId('owner-users-search'),
          page.getByTestId('owner-users-sort'),
          targetCard,
        ]) {
          await element.scrollIntoViewIfNeeded();
          const rect = await element.boundingBox();
          if (!rect) throw new Error('Missing owner users control at ' + width);
          expect(rect.x, 'left overflow: ' + width).toBeGreaterThanOrEqual(-1);
          expect(rect.x + rect.width, 'right overflow: ' + width).toBeLessThanOrEqual(width + 1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      }

      await targetCard.getByRole('button', { name: 'Заблокировать' }).click();
      await expect(page.getByTestId('owner-users-confirm')).toBeVisible();
      for (const width of widths) {
        await page.setViewportSize({ width, height: 410 });
        const dialog = page.getByTestId('owner-users-confirm');
        const rect = await dialog.boundingBox();
        if (!rect) throw new Error('Missing owner confirmation dialog at ' + width);
        expect(rect.x, 'dialog left overflow at ' + width).toBeGreaterThanOrEqual(-1);
        expect(rect.x + rect.width, 'dialog right overflow at ' + width).toBeLessThanOrEqual(width + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      }
      await page.getByTestId('owner-users-cancel').click();
      await expect(page.getByTestId('owner-users-confirm')).toHaveCount(0);
      await targetCard.getByRole('button', { name: 'Заблокировать' }).click();
      await page.getByTestId('owner-users-confirm-submit').click();
      await expect(targetCard.getByRole('button', { name: 'Разблокировать' })).toBeVisible();
      const oldTargetSession = await managedSession.get('/api/auth/session');
      expect(((await oldTargetSession.json()) as { user?: unknown } | null)?.user ?? null).toBeNull();

      await page.getByTestId('owner-users-filter-suspended').click();
      await expect(page.getByTestId('owner-users-list')).toContainText(managedEmail);
      await targetCard.getByRole('button', { name: 'Разблокировать' }).click();
      await page.getByTestId('owner-users-confirm-submit').click();
      await expect(page.getByTestId('owner-users-list')).toHaveCount(0);
      // Unblocking cannot restore the old session which was invalidated.
      const invalidatedSession = await managedSession.get('/api/auth/session');
      expect(((await invalidatedSession.json()) as { user?: unknown } | null)?.user ?? null).toBeNull();

      await page.getByTestId('owner-users-filter-all').click();
      await page.getByTestId('owner-users-search').fill('');
      await page.getByTestId('owner-users-sort').selectOption('email');
      await page.getByTestId('owner-users-direction').click();
      await expect(page.getByTestId('owner-users-list')).toBeVisible();
      const ownerCard = page.locator('[data-testid^="owner-user-"]').filter({ hasText: email });
      await expect(ownerCard.getByText('Владелец')).toBeVisible();
      await expect(ownerCard.getByRole('button', { name: 'Заблокировать' })).toHaveCount(0);
    } finally {
      await managedSession.dispose();
    }
    // Continue the original Passkey lifecycle on the same authenticated owner.
    await page.goto('/settings', { waitUntil: 'networkidle' });

    await expect(page.getByTestId('owner-key-security-state')).toContainText('Три действующих Passkey');
    await expect(page.getByTestId('owner-security-status')).toContainText('Ссылка из письма не выполняет вход');
    await expect(page.getByTestId('owner-add-passkey')).toHaveCount(0);
    const cannotAddFourth = await oldSession.post('/api/webauthn/owner/approval/start', {
      data: { action: 'ADD' },
    });
    expect(cannotAddFourth.status()).toBe(403);

    // Real mobile widths, enlarged Russian text, short viewport:
    // inspect exactly the card/control that might cross a screen boundary.
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 375 });
      const controls = [
        page.getByTestId('passkey-inventory'),
        page.getByTestId('owner-rename-key-' + lost.rowId),
        page.getByTestId('owner-revoke-key-' + lost.rowId),
      ];
      for (const target of controls) {
        await target.scrollIntoViewIfNeeded();
        const box = (await target.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    }

    // An ordinary owner cannot mutate a key using only a JWT or a guessed
    // token, even when the selected row ID is legitimate.
    for (const endpoint of ['/api/webauthn/owner/manage/rename', '/api/webauthn/owner/manage/revoke']) {
      const unauthenticated = await oldSession.post(endpoint, {
        data: { targetId: lost.rowId, approvalToken: 'p'.repeat(43), label: 'Взлом' },
      });
      expect(unauthenticated.status(), endpoint).toBe(403);
    }

    // Fresh, signed approval is scoped to RENAME of the exact selected key.
    // A wrong action or another key must not consume the approval.
    const renameStart = await oldSession.post('/api/webauthn/owner/approval/start', {
      data: { action: 'RENAME', targetId: lost.rowId },
    });
    expect(renameStart.status()).toBe(200);
    const { options: renameOptions } = (await renameStart.json()) as {
      options: { challenge: string; rpId: string };
    };
    const renameApproval = await oldSession.post('/api/webauthn/owner/approval/finish', {
      data: signedQaAssertion({
        email,
        credentialIndex: 2,
        challenge: renameOptions.challenge,
        rpId: renameOptions.rpId,
      }),
    });
    expect(renameApproval.status()).toBe(200);
    const { approvalToken: renameToken } = (await renameApproval.json()) as { approvalToken: string };
    for (const [endpoint, targetId] of [
      ['/api/webauthn/owner/manage/revoke', lost.rowId],
      ['/api/webauthn/owner/manage/rename', signer.rowId],
    ] as const) {
      const wrong = await oldSession.post(endpoint, {
        data: { targetId, approvalToken: renameToken, label: 'Не должно измениться' },
      });
      expect(wrong.status()).toBe(403);
    }
    const renameData = { targetId: lost.rowId, approvalToken: renameToken, label: 'Защищённый Passkey' };
    const [renameA, renameB] = await Promise.all([
      oldSession.post('/api/webauthn/owner/manage/rename', { data: renameData }),
      oldSession.post('/api/webauthn/owner/manage/rename', { data: renameData }),
    ]);
    expect([renameA.status(), renameB.status()].sort((a, b) => a - b)).toEqual([200, 403]);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByText('Защищённый Passkey')).toBeVisible();

    // Rename may be cancelled before verification, and a native WebAuthn
    // NotAllowedError must not write any label. Retry stays available.
    await page.getByTestId('owner-rename-key-' + lost.rowId).click();
    await expect(page.getByTestId('owner-rename-confirmation')).toBeVisible();
    await page.getByTestId('owner-rename-label').fill('Отменённое имя');
    await page.getByTestId('owner-rename-cancel').click();
    await expect(page.getByTestId('owner-rename-confirmation')).toHaveCount(0);
    await page.getByTestId('owner-rename-key-' + lost.rowId).click();
    await page.getByTestId('owner-rename-label').fill('Телефон владельца');
    await installSelectedQaPasskey(page, email, 1);
    await page.evaluate(() => {
      Object.defineProperty(navigator.credentials, 'get', {
        configurable: true,
        value: async () => {
          throw new DOMException('cancelled', 'NotAllowedError');
        },
      });
    });
    await page.getByTestId('owner-rename-save').click();
    await expect(
      page.getByTestId('passkey-inventory').getByRole('alert').filter({ hasText: 'Не удалось изменить название' }),
    ).toContainText('Не удалось изменить название');
    await page.evaluate(() => {
      delete (navigator.credentials as { get?: unknown }).get;
    });
    await page.getByTestId('owner-rename-save').click();
    await expect(page.getByTestId('owner-rename-success')).toBeVisible();
    await expect(page.getByText('Телефон владельца')).toBeVisible();
    const remainsLoggedIn = await oldSession.get('/api/auth/session');
    expect((await remainsLoggedIn.json()) as { user?: { email?: string } }).toMatchObject({ user: { email } });

    // UI cancellation has no security consequence; lost-key confirmation
    // must be explicitly renewed before a signed assertion is requested.
    await page.getByTestId('owner-revoke-key-' + lost.rowId).click();
    await expect(page.getByTestId('owner-revoke-confirmation')).toBeVisible();
    await page.getByTestId('owner-revoke-cancel').click();
    await expect(page.getByTestId('owner-revoke-confirmation')).toHaveCount(0);
    await page.getByTestId('owner-revoke-key-' + lost.rowId).click();

    // Reuse the surviving second key already present in this authenticator.
    // Never reinstall it with counter=0 after the successful rename assertion:
    // the real server validates monotonically increasing hardware counters.
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

    // Competing approved REVOKE actions: one session-bound, signed proof
    // is consumed in the SAME transaction as the selected key deletion.
    const started = await twoKeySession.post('/api/webauthn/owner/approval/start', {
      data: { action: 'REVOKE', targetId: signer.rowId },
    });
    expect(started.status()).toBe(200);
    const { options } = (await started.json()) as {
      options: { challenge: string; rpId: string; allowCredentials?: Array<{ id: string }> };
    };
    expect(options.allowCredentials?.map((entry) => entry.id)).toEqual([survivor.id]);
    const signedApproval = signedQaAssertion({
      email,
      credentialIndex: 2,
      challenge: options.challenge,
      rpId: options.rpId,
    });
    const approved = await twoKeySession.post('/api/webauthn/owner/approval/finish', {
      data: signedApproval,
    });
    expect(approved.status()).toBe(200);
    const { approvalToken } = (await approved.json()) as { approvalToken: string };
    const revokeData = { targetId: signer.rowId, approvalToken };
    const [one, two] = await Promise.all([
      twoKeySession.post('/api/webauthn/owner/manage/revoke', { data: revokeData }),
      twoKeySession.post('/api/webauthn/owner/manage/revoke', { data: revokeData }),
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
      await expect(replacement.getByTestId('owner-key-security-state')).toContainText('Один Passkey достаточен');

      // List retains historical revoked rows by design; only items with
      // an enabled owner rename control represent ACTIVE credentials.
      const activeItems = replacement
        .getByTestId('passkey-items')
        .getByTestId('passkey-item')
        .filter({ has: replacement.locator('[data-testid^="owner-rename-key-"]') });

      // After one-time email recovery, owner can register an independent
      // second AND third real CTAP2 credential. A new device starts empty,
      // so remove the existing virtual authenticator credentials only AFTER
      // each signed owner approval and BEFORE navigator.credentials.create().
      const virtual = await enableVirtualPasskey(replacement);
      let cleared = 0;
      await replacement.route('**/api/webauthn/owner/add/start', async (route) => {
        const response = await route.fetch();
        if (response.ok()) {
          await virtual.cdp.send('WebAuthn.clearCredentials', { authenticatorId: virtual.id });
          cleared++;
        }
        await route.fulfill({ response });
      });
      for (const count of [2, 3]) {
        await expect(replacement.getByTestId('owner-add-passkey')).toBeVisible();
        await replacement.getByTestId('owner-add-passkey').click();
        await expect(replacement.getByTestId('owner-add-success')).toBeVisible({ timeout: 30_000 });
        await expect(replacement.getByTestId('passkey-limit')).toContainText(count + ' из 3');
        await expect(replacement.getByTestId('owner-key-security-state')).toContainText(
          count === 2 ? 'Два действующих Passkey' : 'Три действующих Passkey',
        );
        await expect(activeItems).toHaveCount(count);
        // Historical revoked records stay visible for auditing.
        expect(
          await replacement.getByTestId('passkey-items').getByTestId('passkey-item').count(),
        ).toBeGreaterThanOrEqual(count);
      }
      expect(cleared).toBe(2);
      await expect(replacement.getByTestId('owner-passkey-full')).toBeVisible();
      await expect(replacement.getByTestId('owner-add-passkey')).toHaveCount(0);
      const fourth = await replacement.request.post('/api/webauthn/owner/approval/start', {
        data: { action: 'ADD' },
      });
      expect(fourth.status()).toBe(403);

      // 320–720 px with enlarged text and a long label: report the precise
      // overflowing element rather than hiding page-wide horizontal scroll.
      const newKeys = activeItems;
      await expect(newKeys).toHaveCount(3);
      const newKeyId = await newKeys.first().locator('[data-testid^="owner-rename-key-"]').getAttribute('data-testid');
      if (!newKeyId) throw new Error('New owner Passkey lacks rename control');
      await newKeys.first().locator('[data-testid^="owner-rename-key-"]').click();
      await replacement.getByTestId('owner-rename-label').fill('Очень длинное имя ключа владельца на смартфоне');
      for (const width of widths) {
        await replacement.setViewportSize({ width, height: 375 });
        await replacement.addStyleTag({ content: 'html { font-size: 20px !important; }' });
        const elements = [
          replacement.getByTestId('passkey-inventory'),
          replacement.getByTestId('owner-rename-confirmation'),
          replacement.getByTestId('owner-rename-label'),
          replacement.getByTestId('owner-rename-save'),
          replacement.getByTestId('owner-rename-cancel'),
        ];
        for (const element of elements) {
          await element.scrollIntoViewIfNeeded();
          const rect = await element.boundingBox();
          if (!rect) throw new Error('Missing owner management control at ' + width);
          expect(rect.x, 'left overflow: ' + (await element.getAttribute('data-testid'))).toBeGreaterThanOrEqual(-1);
          expect(
            rect.x + rect.width,
            'right overflow: ' + (await element.getAttribute('data-testid')),
          ).toBeLessThanOrEqual(width + 1);
        }
        expect(await replacement.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      }
      await replacement.getByTestId('owner-rename-cancel').click();
      await expect(replacement.getByTestId('owner-rename-confirmation')).toHaveCount(0);
    } finally {
      await replacement.close();
    }
  } finally {
    await oldSession.dispose();
    await twoKeySession?.dispose();
    await lastKeySession?.dispose();
  }
});
