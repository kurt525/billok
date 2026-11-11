import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** A source-level guard in addition to the actual Auth.js provider tests.
 * Old environment variables and SMTP configuration must not silently revive
 * external sign-in when BillOK moves from Credentials to WebAuthn.
 */
describe('Issue #1 6.9: no undeclared alternate authentication code', () => {
  it('does not register or import forbidden identity providers', () => {
    const auth = source('src/server/auth.ts');
    expect(auth).not.toMatch(/from ['"]next-auth\/providers\/(?:google|nodemailer)['"]/);
    expect(auth).not.toMatch(/type:\s*['"]oidc['"]/);
    expect(auth).not.toContain('PrismaAdapter');
    expect(auth).not.toContain('allowDangerousEmailAccountLinking');
    expect(auth).not.toContain('sendVerificationRequest');
    for (const file of [
      'src/server/lib/google-sign-in.ts',
      'src/server/lib/oidc-sign-in.ts',
      'src/server/lib/magic-link-email.ts',
      'src/server/lib/sign-in-identity.ts',
      'e2e/google-login.spec.ts',
      'e2e/oidc-login.spec.ts',
      'e2e/magic-link.spec.ts',
    ]) {
      expect(existsSync(resolve(process.cwd(), file)), file).toBe(false);
    }
  });

  it('removes OAuth account linking and magic-link token storage from Prisma', () => {
    const prisma = source('prisma/schema.prisma');
    expect(prisma).not.toMatch(/model Account \{/);
    expect(prisma).not.toMatch(/model VerificationToken \{/);
    expect(prisma).not.toMatch(/accounts\s+Account\[\]/);
    expect(prisma).toMatch(/model EmailVerificationRequest \{/);
    expect(prisma).toMatch(/model PasskeyCredential \{/);
  });

  it('cannot restore an external provider by changing Docker or environment variables', () => {
    const env = source('.env.example');
    const docker = source('docker/docker-compose.yml');
    const entrypoint = source('docker/entrypoint.sh');
    const config = source('src/server/lib/auth-config.ts');
    for (const file of [env, docker, entrypoint, config]) {
      expect(file).not.toMatch(/GOOGLE_CLIENT_ID|OIDC_ISSUER|OIDC_CLIENT_ID|OIDC_ALLOW_EMAIL_LINKING/);
      expect(file).not.toContain('DISABLE_PASSWORD_LOGIN');
      expect(file).not.toMatch(/Sign in with Google|Magic Link:\s*enabled/);
    }
    expect(config).toContain('readRegistrationEmailConfig');
    expect(source('src/server/lib/email-verification-email.ts')).toContain('sendRussianRegistrationVerificationEmail');
    expect(source('src/server/lib/webauthn-registration.ts')).toContain('verifyRegistrationResponse');
    expect(source('package.json')).not.toContain('@auth/prisma-adapter');
  });

  it('has no hidden external-provider login buttons or requests', () => {
    const login = source('src/app/[locale]/(auth)/login/page.tsx');
    expect(login).not.toContain('google-sign-in');
    expect(login).not.toContain('oidc-sign-in');
    expect(login).not.toContain("signIn('nodemailer'");
    expect(login).not.toContain("signIn('google'");
    expect(login).not.toContain("signIn('oidc'");
    const errors = source('src/lib/sign-in-errors.ts');
    expect(errors).not.toContain('GOOGLE_ERROR_KEYS');
    expect(errors).not.toContain('OIDC_ERROR_KEYS');
  });
});
