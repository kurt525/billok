import { existsSync, readFileSync } from 'node:fs';
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

  it('uses a single 44px WebAuthn sign-in button without password fields', () => {
    const login = source('src/app/[locale]/(auth)/login/page.tsx');
    expect(login).toContain('startAuthentication({ optionsJSON: data.options })');
    expect(login).toContain("signIn('passkey'");
    expect(login).toContain('data-testid="passkey-login"');
    expect(login).not.toContain('type="password"');
    // SMTP email is only for account verification, never for login.
    expect(login).not.toContain('autoComplete="email"');
    expect(login).not.toContain('autoComplete="current-password"');
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
    expect(register).not.toContain('type="password"');
    expect(register.match(/className="h-11 min-w-0 text-base"/g)).toHaveLength(3);
    expect(register).toContain('min-h-11 w-full');
    expect(register).toContain('registration.verificationRequired');
    expect(register).toContain('setConfirmationEmail(registration.email)');
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
    expect(verify).toContain('startRegistration({ optionsJSON: payload.options })');
    expect(register).not.toContain('initialEmail={password}');
  });

  it('has no password reset or change endpoints and keeps WebAuthn sign-in', () => {
    const auth = source('src/server/auth.ts');
    const router = source('src/server/trpc/routers/auth.ts');
    expect(auth).not.toContain('authorizePasswordLogin');
    expect(auth).toContain("id: 'passkey'");
    expect(router).not.toMatch(/requestPasswordReset|resetPassword|changePassword/);
    expect(router).not.toContain('passwordHash');
  });

  it('has no old email-as-login waiting page', () => {
    expect(existsSync(resolve(process.cwd(), 'src/app/[locale]/(auth)/verify-request/page.tsx'))).toBe(false);
    expect(source('src/middleware.ts')).not.toContain("'/verify-request'");
  });
});
