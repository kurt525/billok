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
    expect(login).toContain('autoComplete="email"');
    expect(login.match(/className="h-11 min-w-0 text-base"/g)).toHaveLength(3);
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
  });

  it('keeps the confirmation email page back action tappable', () => {
    const verify = source('src/app/[locale]/(auth)/verify-request/page.tsx');
    expect(verify).toContain('inline-flex min-h-11 items-center justify-center');
  });
});
