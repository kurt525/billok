import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');
function filesBelow(path: string): string[] {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => {
      const sub = join(path, entry.name);
      return entry.isDirectory() ? filesBelow(sub) : entry.isFile() ? [sub] : [];
    })
    .sort();
}

describe('Issue #1 6.10.4: passwordless cutover must not leave a hidden sign-in path', () => {
  it('allows only the WebAuthn login-ticket provider, never a password or SMTP authentication provider', () => {
    const auth = source('src/server/auth.ts');
    const providerImports = [...auth.matchAll(/from ['"]next-auth\/providers\/([^'"]+)['"]/gu)].map(
      (result) => result[1],
    );
    expect(providerImports).toEqual(['credentials']);
    expect(auth).toContain("id: 'passkey'");
    expect(auth).toContain('providers: [');
    expect(auth).toMatch(/authorize:\s*\(credentials\)\s*=>\s*consumePasskeyLoginTicket\(/u);
    expect(auth).not.toMatch(/(?:passwordHash|comparePassword|bcrypt|argon2|sha256Password)/iu);
    expect(auth).not.toMatch(/(?:google|oidc|nodemailer|email|github|keycloak|azure|facebook|apple)\s*\(/iu);
    expect(auth).not.toContain('PrismaAdapter');
    expect(auth).not.toContain('sendVerificationRequest');
    expect(auth).toMatch(/session:\s*\{\s*strategy:\s*['"]jwt['"]/u);
    const login = source('src/app/[locale]/(auth)/login/page.tsx');
    expect(login).toContain("signIn('passkey'");
    expect(login).not.toContain('type="password"');
    expect(login).not.toMatch(/signIn\(['"](?:google|oidc|email|nodemailer|credentials)['"]/iu);
  });

  it('has no password, reset or third-party account model in the current database schema', () => {
    const schema = source('prisma/schema.prisma');
    expect(schema).toMatch(/model PasskeyCredential \{/u);
    expect(schema).toMatch(/model PasskeyLoginTicket \{/u);
    expect(schema).toMatch(/model OwnerBootstrap \{/u);
    expect(schema).not.toMatch(/(?:passwordHash|PasswordResetRequest|model Account \{|model VerificationToken \{)/u);
    // A prelaunch installation may have the OLD columns/tables in its database.
    // The idempotent SQL drop must permanently remove them on upgrade.
    const migration = source('prisma/migrations/password_auth_drop.sql');
    expect(migration).toMatch(/DROP TABLE IF EXISTS "PasswordResetRequest"\s*;/u);
    expect(migration).toMatch(/ALTER TABLE IF EXISTS "User" DROP COLUMN IF EXISTS "passwordHash"\s*;/u);
    const entrypoint = source('docker/entrypoint.sh');
    expect(entrypoint.indexOf('for sqlfile in /app/prisma/migrations/*.sql')).toBeGreaterThanOrEqual(0);
    expect(entrypoint.indexOf('for sqlfile in /app/prisma/migrations/*.sql')).toBeLessThan(
      entrypoint.indexOf('prisma/build/index.js db push'),
    );
  });

  it('has no undeclared login or password reset route, even if someone knows the old URL', () => {
    const webRoutes = filesBelow('src/app/[locale]/(auth)').filter((file) => file.endsWith('/page.tsx'));
    expect(webRoutes).toEqual([
      'src/app/[locale]/(auth)/login/page.tsx',
      'src/app/[locale]/(auth)/recover-passkey/page.tsx',
      'src/app/[locale]/(auth)/register/page.tsx',
      'src/app/[locale]/(auth)/setup-owner/page.tsx',
      'src/app/[locale]/(auth)/verify-email/page.tsx',
    ]);
    const directAuthRoutes = filesBelow('src/app/api/auth').filter((file) => file.endsWith('/route.ts'));
    expect(directAuthRoutes).toEqual(['src/app/api/auth/[...nextauth]/route.ts']);
    const loginConfig = source('src/server/trpc/routers/auth.ts');
    expect(loginConfig).toContain('return { passkeyLogin: true }');
    expect(loginConfig).not.toMatch(
      /(?:requestPasswordReset|resetPassword|changePassword|authorizePasswordLogin|magicLinkLogin)\s*:/u,
    );
    for (const file of filesBelow('src/app/api/webauthn').filter((file) => file.endsWith('/route.ts'))) {
      expect(file).not.toMatch(/(?:password|magic-link|google|oidc|reset)/iu);
    }
  });

  it('initial owner and email confirmation/recovery cannot mint sessions or login tickets', () => {
    const bootstrap = source('src/server/lib/owner-bootstrap.ts');
    const ownerScript = source('scripts/bootstrap-owner.ts');
    const recovery = source('src/server/lib/passkey-email-recovery.ts');
    const confirm = source('src/server/lib/registration-email-confirmation.ts');
    const register = source('src/server/lib/registration-invite-delivery.ts');
    const onlyTicketIssuer = source('src/server/lib/passkey-login.ts');
    for (const [path, file] of [
      ['bootstrap-owner.ts', bootstrap],
      ['scripts/bootstrap-owner.ts', ownerScript],
      ['passkey-email-recovery.ts', recovery],
      ['registration-email-confirmation.ts', confirm],
      ['registration-invite-delivery.ts', register],
    ] as const) {
      expect(file, path).not.toMatch(/(?:passkeyLoginTicket\.create|signIn\(|authorizePasswordLogin|PrismaAdapter)/u);
    }
    expect(bootstrap).toContain('const [existing, users]');
    expect(bootstrap).toContain('if (existing || users !== 0)');
    expect(ownerScript).toContain('process.stdin.isTTY');
    expect(recovery).toContain('verifyRegistrationResponse');
    expect(onlyTicketIssuer).toContain('verifyAuthenticationResponse');
    expect(onlyTicketIssuer).toContain('passkeyLoginTicket.create');
  });

  it('SMTP and DB passwords remain infrastructure secrets, not a new user-login option', () => {
    const env = source('.env.example');
    const docker = source('docker/docker-compose.yml');
    const admin = source('src/server/lib/auth-config.ts');
    for (const file of [env, docker, admin]) {
      expect(file).not.toMatch(
        /(?:DISABLE_PASSWORD_LOGIN|ENABLE_PASSWORD_LOGIN|ALLOW_PASSWORD_AUTH|GOOGLE_CLIENT_ID|OIDC_ISSUER|OIDC_ALLOW_EMAIL_LINKING)/u,
      );
    }
    expect(env).toContain('EMAIL_SERVER_PASSWORD');
    expect(env).toContain('DB_PASSWORD');
    expect(admin).toContain('readRegistrationEmailConfig');
    expect(source('prisma/seed.ts')).not.toMatch(/passwordHash\s*:/u);
    expect(source('src/server/lib/passkey-recovery-email.ts')).not.toContain('passkeyLoginTicket.create');
  });
});
