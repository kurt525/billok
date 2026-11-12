import { expect, test } from '@playwright/test';
import { authedPasskeyContext, qaPasskey } from './passkey-auth';

// No fake Auth.js bypass. An actual ES256 signed login on a disposable
// non-owner, single-Passkey account must never grant owner key management.
const email = 'member-manage@mail.ru';
const widths = [320, 360, 393, 412, 600, 720] as const;

test('ordinary user: one-key inventory only, all owner key-management routes forbidden', async ({ page }) => {
  test.setTimeout(100_000);
  const key = qaPasskey(email, 0);
  if (!key.rowId) throw new Error('Missing disposable member key row ID');
  const session = await authedPasskeyContext(email);
  try {
    await page.context().addCookies((await session.storageState()).cookies);
    await page.goto('/settings', { waitUntil: 'networkidle' });

    await expect(page.getByTestId('passkey-limit')).toContainText('1 из 1');
    await expect(page.getByTestId('owner-security-status')).toHaveCount(0);
    await expect(page.getByTestId('passkey-items').getByTestId('passkey-item')).toHaveCount(1);

    for (const width of widths) {
      await page.setViewportSize({ width, height: 375 });
      await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });
      const inventory = page.getByTestId('passkey-inventory');
      await inventory.scrollIntoViewIfNeeded();
      const box = await inventory.boundingBox();
      if (!box) throw new Error('Missing inventory on mobile viewport ' + width);
      expect(box.x, 'left overflow at ' + width).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, 'right overflow at ' + width).toBeLessThanOrEqual(width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      await expect(page.getByTestId('owner-add-passkey')).toHaveCount(0);
      await expect(page.locator('[data-testid^="owner-rename-key-"]')).toHaveCount(0);
      await expect(page.locator('[data-testid^="owner-revoke-key-"]')).toHaveCount(0);
    }

    for (const action of ['ADD', 'RENAME', 'REVOKE'] as const) {
      const response = await session.post('/api/webauthn/owner/approval/start', {
        data: { action, ...(action === 'ADD' ? {} : { targetId: key.rowId }) },
      });
      expect(response.status(), 'No signed management approval for a regular member').toBe(403);
    }
    for (const endpoint of [
      '/api/webauthn/owner/add/start',
      '/api/webauthn/owner/manage/rename',
      '/api/webauthn/owner/manage/revoke',
      '/api/webauthn/owner/revoke/start',
    ]) {
      const body = endpoint.endsWith('/add/start')
        ? { approvalToken: 'p'.repeat(43) }
        : { targetId: key.rowId, approvalToken: 'p'.repeat(43), label: 'Подмена имени' };
      const result = await session.post(endpoint, { data: body });
      expect(result.status(), 'Owner-only route: ' + endpoint).toBe(403);
    }
    await page.goto('/admin/users', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('owner-users-page')).toHaveCount(0);
    const ownerQuery = await session.get(
      '/api/trpc/admin.ownerRegisteredUsers?input=' + encodeURIComponent(JSON.stringify({ json: { limit: 1 } })),
    );
    expect(ownerQuery.status()).toBe(403);
    const ownerMutation = await session.post('/api/trpc/admin.ownerSetUserSuspended', {
      data: { json: { userId: key.rowId, suspend: true } },
    });
    expect(ownerMutation.status()).toBe(403);
    expect((await (await session.get('/api/auth/session')).json()) as { user?: { email?: string } }).toMatchObject({
      user: { email },
    });
  } finally {
    await session.dispose();
  }
});
