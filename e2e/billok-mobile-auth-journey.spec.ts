import { expect, test, type Page } from '@playwright/test';
import { enableVirtualPasskey, loginWithPasskey } from './passkey-auth';

// All network calls, PostgreSQL, SMTP, and browser authenticator are genuine.
// No mock responses or secret test-only HTTP endpoint.
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

const mailbox = process.env.BILLOK_QA_MAILBOX_URL ?? '';
const ruInvite = process.env.BILLOK_QA_AUTH_INVITE_RU ?? '';
const suInvite = process.env.BILLOK_QA_AUTH_INVITE_SU ?? '';
const expiredConfirm = process.env.BILLOK_QA_EXPIRED_CONFIRM ?? '';

async function latestMailLink(page: Page, email: string, count: number) {
  let matches: string[] = [];
  await expect
    .poll(
      async () => {
        const response = await page.request.get(mailbox + '/messages?to=' + encodeURIComponent(email));
        if (!response.ok()) return 0;
        const result = (await response.json()) as { messages: { links: string[] }[] };
        matches = result.messages.flatMap((m) => m.links).filter((link) => new URL(link).pathname === '/verify-email');
        return matches.length;
      },
      { timeout: 20_000, intervals: [200, 500, 900, 1200] },
    )
    .toBeGreaterThanOrEqual(count);
  const link = matches[count - 1]!;
  expect(new URL(link).searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return link;
}

async function register(page: Page, email: string, inviteCode: string) {
  await page.goto('/register', { waitUntil: 'networkidle' });
  await page.getByLabel('Имя').fill('QA Участник');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Код приглашения').fill(inviteCode);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(page.getByRole('status')).toContainText('Проверьте электронную почту');
  await expect(page.getByTestId('registration-resend-form')).toBeVisible();
}

test('isolated invite/email/SMTP/verification/Passkey journey including ru and su', async ({ page }) => {
  test.setTimeout(180_000);
  if (!mailbox || !ruInvite || !suInvite || !expiredConfirm) {
    throw new Error('Mobile auth journey requires disposable SMTP and PostgreSQL');
  }
  await enableVirtualPasskey(page);
  const unique = ruInvite.replace(/^qa-ru-/, '');
  const ruEmail = 'qa-journey-' + unique + '@mail.ru';
  const suEmail = 'qa-journey-' + unique + '@mail.su';

  // Reject email TLDs outside .ru and .su before allocating any invitation.
  await page.goto('/register', { waitUntil: 'networkidle' });
  await page.getByLabel('Имя').fill('QA Участник');
  await page.getByLabel('Электронная почта').fill('unwanted-' + unique + '@example.com');
  await page.getByLabel('Код приглашения').fill(ruInvite);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(page.getByText('Для регистрации используйте почту только в доменах .ru или .su.')).toBeVisible();

  await register(page, ruEmail, ruInvite);
  const first = await latestMailLink(page, ruEmail, 1);

  // A pending account has no Passkey and cannot sign in.
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.getByTestId('passkey-login').click();
  await expect(page.getByTestId('login-error')).toBeVisible();
  await expect(page).not.toHaveURL(/\/dashboard(?:\?.*)?$/);

  // Resend revokes earlier email link only after SMTP accepts delivery.
  await page.goto('/verify-email?token=invalid', { waitUntil: 'networkidle' });
  const resend = page.getByTestId('registration-resend-form');
  await resend.getByLabel('Электронная почта для регистрации').fill(ruEmail);
  await resend.getByRole('button', { name: 'Запросить новую ссылку' }).click();
  await expect(resend.getByRole('status')).toContainText('Если для этого адреса');
  const replacement = await latestMailLink(page, ruEmail, 2);
  expect(replacement).not.toBe(first);

  await page.goto(first, { waitUntil: 'networkidle' });
  await page.getByTestId('verify-create-passkey').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Ссылка недействительна' })).toContainText(
    'Ссылка недействительна',
  );

  await page.goto(replacement, { waitUntil: 'networkidle' });
  await page.getByTestId('verify-create-passkey').click();
  await expect(page.getByRole('status')).toContainText('Passkey создан');
  await loginWithPasskey(page);

  // After a credential exists, the consumed token never grants another key.
  await page.context().clearCookies();
  await page.goto(replacement, { waitUntil: 'networkidle' });
  await page.getByTestId('verify-create-passkey').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Ссылка недействительна' })).toContainText(
    'Ссылка недействительна',
  );
  await page.goto('/verify-email?token=' + expiredConfirm, { waitUntil: 'networkidle' });
  await page.getByTestId('verify-create-passkey').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Ссылка недействительна' })).toContainText(
    'Ссылка недействительна',
  );

  // Independently register .su with another invitation and a separate key.
  await register(page, suEmail, suInvite);
  const suLink = await latestMailLink(page, suEmail, 1);
  // A second independent account uses an independent passkey on this simulated device.
  const virtual = await enableVirtualPasskey(page);
  await virtual.cdp.send('WebAuthn.clearCredentials', { authenticatorId: virtual.id });
  await page.goto(suLink, { waitUntil: 'networkidle' });
  await page.getByTestId('verify-create-passkey').click();
  await expect(page.getByRole('status')).toContainText('Passkey создан');
  await loginWithPasskey(page);
});
