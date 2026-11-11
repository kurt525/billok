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
    expect(source('src/server/lib/owner-bootstrap.ts')).toContain('passwordHash: null');
  });
  it('binds initial setup to a confirmation link and two distinct WebAuthn credentials', () => {
    const start = source('src/app/api/webauthn/registration/start/route.ts');
    expect(start).toContain('confirmRegistrationEmail');
    expect(start).toContain('canRetryOwnerInitialPasskey');
    const backup = source('src/server/lib/owner-backup-passkey.ts');
    expect(backup).toContain("purpose: 'ADD_KEY'");
    expect(backup).toContain('verifyRegistrationResponse');
    expect(backup).toContain('user.passkeyCredentials.length !== 1');
    expect(backup).toContain('OWNER_BOOTSTRAP_COMPLETED');
    expect(source('src/app/api/webauthn/owner/backup/start/route.ts')).toContain('await auth()');
    expect(source('src/app/api/webauthn/owner/backup/finish/route.ts')).toContain('await auth()');
    expect(source('src/app/[locale]/(auth)/setup-owner/page.tsx')).not.toContain('type="password"');
    expect(source('src/middleware.ts')).toContain("'/setup-owner'");
  });
  it('never restores removed Magic Link Google OIDC providers', () => {
    const auth = source('src/server/auth.ts');
    expect(auth).not.toMatch(/next-auth\/providers\/(?:google|nodemailer)/);
    expect(auth).not.toMatch(/type:\s*['"]oidc['"]/);
  });
});
