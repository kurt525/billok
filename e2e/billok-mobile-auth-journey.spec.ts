import { expect, test, type Page } from '@playwright/test';

// True API, SMTP and PostgreSQL end-to-end checks. No mocked tRPC responses.
// The test exists ONLY in the disposable mobile Chromium CI environment.
test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

const mailbox = process.env.BILLOK_QA_MAILBOX_URL ?? '';
const ruInvite = process.env.BILLOK_QA_AUTH_INVITE_RU ?? '';
const suInvite = process.env.BILLOK_QA_AUTH_INVITE_SU ?? '';
const expiredConfirm = process.env.BILLOK_QA_EXPIRED_CONFIRM ?? '';
const expiredReset = process.env.BILLOK_QA_EXPIRED_RESET ?? '';
const originalPassword = 'qa-original-password-123';
const newPassword = 'qa-replaced-password-456';

async function latestMailLink(page: Page, email: string, path: '/verify-email' | '/reset-password', count: number) {
  let matches: string[] = [];
  await expect
    .poll(
      async () => {
        const response = await page.request.get(mailbox + '/messages?to=' + encodeURIComponent(email));
        if (!response.ok()) return 0;
        const result = (await response.json()) as { messages: { links: string[] }[] };
        matches = result.messages.flatMap((m) => m.links).filter((link) => new URL(link).pathname === path);
        return matches.length;
      },
      { timeout: 20_000, intervals: [200, 500, 900, 1200] },
    )
    .toBeGreaterThanOrEqual(count);
  const link = matches[count - 1]!;
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  expect(new URL(link).searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return link;
}

async function login(page: Page, email: string, password: string, allowed: boolean) {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input#email').fill(email);
  await page.locator('input#password').fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  if (allowed) {
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Главная' })).toBeVisible();
  } else {
    await expect(page.getByText('Неверная электронная почта или пароль', { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/\/dashboard(?:\?.*)?$/);
  }
}

async function register(page: Page, email: string, inviteCode: string) {
  await page.goto('/register', { waitUntil: 'networkidle' });
  await page.getByLabel('Имя').fill('QA Участник');
  await page.getByLabel('Электронная почта').fill(email);
  await page.getByLabel('Пароль').fill(originalPassword);
  await page.getByLabel('Код приглашения').fill(inviteCode);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(page.getByRole('status')).toContainText('Проверьте электронную почту');
  await expect(page.getByTestId('registration-resend-form')).toBeVisible();
}

test('isolated invite/email/SMTP/verification/login/reset journey including ru and su', async ({ page }) => {
  test.setTimeout(180_000);
  if (!mailbox || !ruInvite || !suInvite || !expiredConfirm || !expiredReset) {
    throw new Error('Mobile auth journey requires disposable SMTP and PostgreSQL fixture environment');
  }
  const unique = ruInvite.replace(/^qa-ru-/, '');
  const ruEmail = 'qa-journey-' + unique + '@mail.ru';
  const suEmail = 'qa-journey-' + unique + '@mail.su';

  // Refuse non-Russian registration domains on the actual backend.
  await page.goto('/register', { waitUntil: 'networkidle' });
  await page.getByLabel('Имя').fill('QA Участник');
  await page.getByLabel('Электронная почта').fill('unwanted-' + unique + '@example.com');
  await page.getByLabel('Пароль').fill(originalPassword);
  await page.getByLabel('Код приглашения').fill(ruInvite);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(page.getByText('Для регистрации используйте почту только в доменах .ru или .su.')).toBeVisible();
  await expect(page.getByRole('status')).toHaveCount(0);

  // Both real registration and real SMTP delivery create a pending account.
  await register(page, ruEmail, ruInvite);
  const originalVerify = await latestMailLink(page, ruEmail, '/verify-email', 1);
  await login(page, ruEmail, originalPassword, false);

  // A pending account can request another link; the earlier one is revoked
  // only after the replacement has been accepted by SMTP.
  await page.goto('/verify-email?token=invalid', { waitUntil: 'networkidle' });
  const resend = page.getByTestId('registration-resend-form');
  await resend.getByLabel('Электронная почта для регистрации').fill(ruEmail);
  await resend.getByRole('button', { name: 'Запросить новую ссылку' }).click();
  await expect(resend.getByRole('status')).toContainText('Если для этого адреса');
  const replacement = await latestMailLink(page, ruEmail, '/verify-email', 2);
  expect(replacement).not.toBe(originalVerify);

  await page.goto(originalVerify, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Подтвердить адрес' }).click();
  await expect(page.getByText('Ссылка недействительна', { exact: false })).toBeVisible();
  await page.goto(replacement, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Подтвердить адрес' }).click();
  await expect(page.getByRole('status')).toContainText('подтвержд');
  await expect(page).toHaveURL(/\/verify-email$/);
  await login(page, ruEmail, originalPassword, true);

  // Already-confirmed link is single-use, and an expired link is rejected.
  await page.context().clearCookies();
  await page.goto(replacement, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Подтвердить адрес' }).click();
  await expect(page.getByText('Ссылка недействительна', { exact: false })).toBeVisible();
  await page.goto('/verify-email?token=' + expiredConfirm, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Подтвердить адрес' }).click();
  await expect(page.getByText('Ссылка недействительна', { exact: false })).toBeVisible();

  // Password recovery returns a neutral answer for unknown and real users.
  await page.goto('/forgot-password', { waitUntil: 'networkidle' });
  const resetForm = page.getByTestId('forgot-password-form');
  await resetForm.getByLabel('Электронная почта').fill('missing-' + unique + '@mail.ru');
  await resetForm.getByRole('button', { name: 'Получить ссылку' }).click();
  await expect(page.getByRole('status')).toContainText('Если для этого адреса');
  await resetForm.getByLabel('Электронная почта').fill(ruEmail);
  await resetForm.getByRole('button', { name: 'Получить ссылку' }).click();
  await expect(page.getByRole('status')).toContainText('Если для этого адреса');
  const resetLink = await latestMailLink(page, ruEmail, '/reset-password', 1);
  await page.goto('/reset-password?token=' + expiredReset, { waitUntil: 'networkidle' });
  await page.getByTestId('reset-password-form').getByLabel('Новый пароль', { exact: true }).fill(newPassword);
  await page.getByLabel('Повторите новый пароль').fill(newPassword);
  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(page.locator('p[role="alert"]')).toContainText('Ссылка недействительна');

  await page.goto(resetLink, { waitUntil: 'networkidle' });
  await page.getByLabel('Новый пароль', { exact: true }).fill(newPassword);
  await page.getByLabel('Повторите новый пароль').fill(newPassword);
  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(page.getByRole('status')).toContainText('Пароль изменён');
  await page.goto(resetLink, { waitUntil: 'networkidle' });
  await page.getByLabel('Новый пароль', { exact: true }).fill(newPassword);
  await page.getByLabel('Повторите новый пароль').fill(newPassword);
  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(page.locator('p[role="alert"]')).toContainText('Ссылка недействительна');

  await login(page, ruEmail, originalPassword, false);
  await login(page, ruEmail, newPassword, true);
  await page.context().clearCookies();

  // Independently accept .su registrations with a distinct one-time invite.
  await register(page, suEmail, suInvite);
  const suLink = await latestMailLink(page, suEmail, '/verify-email', 1);
  await page.goto(suLink, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Подтвердить адрес' }).click();
  await expect(page.getByRole('status')).toContainText('подтвержд');
  await login(page, suEmail, originalPassword, true);
});
