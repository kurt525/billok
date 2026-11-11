import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('Mobile authentication and verification forms', () => {
  it('keeps public auth pages scrollable when Android keyboard reduces visual viewport', () => {
    const layout = source('src/app/[locale]/(auth)/layout.tsx');
    expect(layout).toContain('min-h-dvh');
    expect(layout).toContain('items-start');
    expect(layout).toContain('overflow-x-clip');
    expect(layout).not.toContain('overflow-hidden');
  });

  it('uses touch-size credentials, email autofill and 44px sign-in buttons', () => {
    const login = source('src/app/[locale]/(auth)/login/page.tsx');
    expect(login).toContain('autoComplete="username"');
    expect(login).toContain('autoComplete="current-password"');
    // SMTP email is only for account verification, never for login.
    expect(login).not.toContain('autoComplete="email"');
    expect(login.match(/className="h-11 min-w-0 text-base"/g)).toHaveLength(2);
    expect(login).not.toContain('magicLinkForm');
    expect(login).not.toContain('oidc-sign-in');
    expect(login).not.toContain('google-sign-in');
    expect(login).not.toContain('h-10 text-sm');
    expect(login).toContain('min-h-11');
  });

  it('treats registration name as display name, not browser-supplied full name', () => {
    const register = source('src/app/[locale]/(auth)/register/page.tsx');
    expect(register).toContain('maxLength={100}');
    expect(register).toContain('autoComplete="off"');
    expect(register).not.toContain('autoComplete="name"');
    expect(register).toContain('autoComplete="email"');
    expect(register).toContain('autoComplete="new-password"');
    expect(register.match(/className="h-11 min-w-0 text-base"/g)).toHaveLength(4);
    expect(register).toContain('min-h-11 w-full');
    expect(register).toContain("'verificationRequired' in registration");
    expect(register).toContain('setConfirmationEmail(email)');
    expect(register).toContain('confirmationPendingDescription');
  });

  it('keeps the generic resend email form touch accessible without exposing account existence', () => {
    const form = source('src/components/auth/registration-email-resend-form.tsx');
    expect(form).toContain('resendRegistrationVerification.useMutation()');
    expect(form).toContain('type="email"');
    expect(form).toContain('maxLength={254}');
    expect(form).toContain('autoComplete="email"');
    expect(form).toContain('min-h-11 w-full');
    expect(form).toContain('disabled={resend.isPending}');
    expect(form).toContain('role="status"');
    expect(form).toContain('role="alert"');
    expect(form).not.toContain('inviteCode');
    const messages = JSON.parse(source('messages/ru/auth.json')) as {
      resendVerification: { accepted: string };
    };
    expect(messages.resendVerification.accepted).toContain('Если для этого адреса');
    expect(messages.resendVerification.accepted).toContain('«Спам»');
  });

  it('offers the protected resend form only for invalid links and pending registration', () => {
    const verify = source('src/app/[locale]/(auth)/verify-email/page.tsx');
    const register = source('src/app/[locale]/(auth)/register/page.tsx');
    expect(verify).toContain(') : expired ? (');
    expect(verify).toContain('<RegistrationEmailResendForm />');
    expect(verify.indexOf('<RegistrationEmailResendForm />')).toBeLessThan(verify.indexOf("{t('backToLogin')}"));
    expect(register).toContain('<RegistrationEmailResendForm initialEmail={confirmationEmail} />');
    expect(register).toContain("setPassword('')");
    expect(register).not.toContain('initialEmail={password}');
  });

  it('exposes both password recovery screens without an authenticated session', () => {
    const middleware = source('src/middleware.ts');
    const forgot = source('src/app/[locale]/(auth)/forgot-password/page.tsx');
    const reset = source('src/app/[locale]/(auth)/reset-password/page.tsx');
    expect(middleware).toContain("'/forgot-password'");
    expect(middleware).toContain("'/reset-password'");
    expect(forgot).toContain('requestPasswordReset.useMutation()');
    expect(reset).toContain('resetPassword.useMutation()');
    expect(forgot).toContain('min-h-11 w-full');
    expect(reset).toContain('min-h-11 w-full');
  });

  it('keeps the confirmation email page back action tappable', () => {
    const verify = source('src/app/[locale]/(auth)/verify-request/page.tsx');
    expect(verify).toContain('inline-flex min-h-11 items-center justify-center');
  });
});
