import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Issue #1 owner bootstrap has no public account creation, password or hidden login', () => {
  it('is only an operator-run command with an explicit acknowledgement', () => {
    const script = source('scripts/bootstrap-owner.ts');
    expect(script).toContain('process.stdin.isTTY');
    expect(script).toContain('process.stderr.isTTY');
    expect(script).toContain('readOwnerBootstrapConfiguration(process.env)');
    expect(script).not.toMatch(/passwordHash:\s*['"]/);
    expect(source('src/server/lib/owner-bootstrap.ts')).not.toContain('passwordHash');
  });
  it('completes setup with exactly one verified initial key and leaves optional keys to account management', () => {
    const start = source('src/app/api/webauthn/registration/start/route.ts');
    expect(start).toContain('confirmRegistrationEmail');
    expect(start).toContain('canRetryOwnerInitialPasskey');
    const enrollment = source('src/server/lib/webauthn-registration.ts');
    expect(enrollment).toContain('OWNER_BOOTSTRAP_COMPLETED');
    expect(enrollment).toContain('ownerBootstrap.updateMany');
    expect(enrollment).toContain('optionalMaxPasskeys: 3');
    const status = source('src/app/api/webauthn/owner/bootstrap/status/route.ts');
    expect(status).toContain('activeKeys >= 1');
    expect(status).not.toContain('activeKeys >= 2');
    const page = source('src/app/[locale]/(auth)/setup-owner/page.tsx');
    expect(page).not.toContain('owner-add-backup-passkey');
    expect(page).not.toContain('type="password"');
    expect(page).toContain('Дополнительные Passkey необязательны');
    expect(source('scripts/bootstrap-owner.ts')).not.toContain('двух разных ключей');
    expect(source('src/middleware.ts')).toContain("'/setup-owner'");
  });

  it('never restores removed Magic Link Google OIDC providers', () => {
    const auth = source('src/server/auth.ts');
    expect(auth).not.toMatch(/next-auth\/providers\/(?:google|nodemailer)/);
    expect(auth).not.toMatch(/type:\s*['"]oidc['"]/);
  });
});
