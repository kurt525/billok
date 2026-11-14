import { expect, test } from '@playwright/test';
import { authedPasskeyContext, loginWithPasskey } from './passkey-auth';

/** CI-only: real signatures and browser ceremony, never auth/session mocking. */
test('disposable Alice logs in with WebAuthn and gets authenticated API access', async ({ page }) => {
  test.setTimeout(90_000);
  await loginWithPasskey(page, 'alice@example.com');
  await expect(page.getByRole('heading', { name: 'Главная' })).toBeVisible();
  const api = await authedPasskeyContext('bob@example.com');
  try {
    const res = await api.get('/api/auth/session');
    expect(res.ok()).toBe(true);
    const session = (await res.json()) as { user?: { email?: string } };
    expect(session.user?.email).toBe('bob@example.com');
  } finally {
    await api.dispose();
  }
});
