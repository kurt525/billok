import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/** Issue #1 6.9: external provider absence is the security boundary.
 * Passkey one-time tickets are the only sign-in credentials.
 */
const { nextAuth, authMock, consumeTicket, db, logger } = vi.hoisted(() => ({
  nextAuth: vi.fn(),
  authMock: vi.fn(),
  consumeTicket: vi.fn(),
  db: { user: { findUnique: vi.fn() } },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('next-auth', () => ({ default: nextAuth }));
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn((options) => ({ id: 'credentials', ...options })),
}));
vi.mock('./db', () => ({ db }));
vi.mock('./lib/logger', () => ({ logger }));
vi.mock('./lib/passkey-login', () => ({ consumePasskeyLoginTicket: consumeTicket }));

interface AuthConfig {
  providers: { id: string; [key: string]: unknown }[];
  session: { strategy: string };
  adapter?: unknown;
  callbacks: {
    jwt: (input: {
      token: Record<string, unknown>;
      user?: { id: string; name?: string; locale?: string };
    }) => Promise<Record<string, unknown>>;
    session: (input: {
      session: { user: { id?: string; name?: string | null; locale?: string } };
      token: Record<string, unknown>;
    }) => { user: { id?: string; name?: string | null; locale?: string } };
  };
}

const externalEnv = {
  GOOGLE_CLIENT_ID: 'fake-client',
  GOOGLE_CLIENT_SECRET: 'fake-secret',
  OIDC_ISSUER: 'https://sso.example.invalid',
  OIDC_CLIENT_ID: 'fake-id',
  OIDC_CLIENT_SECRET: 'fake-secret',
  OIDC_AUTO_REGISTER: 'true',
  OIDC_ALLOW_EMAIL_LINKING: 'true',
  AUTH_GOOGLE_ID: 'fake-client-autoconfig',
  AUTH_GOOGLE_SECRET: 'fake-client-secret',
  AUTH_OIDC_ID: 'fake-oidc-client',
  AUTH_OIDC_SECRET: 'fake-oidc-secret',
  AUTH_EMAIL_SERVER: 'smtp://fake:fake@localhost:2525',
  AUTH_EMAIL_FROM: 'someone@example.ru',
  EMAIL_SERVER_HOST: 'smtp.example.invalid',
  EMAIL_SERVER_USER: 'account@example.ru',
  EMAIL_SERVER_PASSWORD: 'fake-smtp-secret',
};

async function loadAuth(overrides: Record<string, string> = {}): Promise<AuthConfig> {
  for (const key of Object.keys(externalEnv)) vi.stubEnv(key, '');
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
  vi.resetModules();
  let config: AuthConfig | undefined;
  nextAuth.mockImplementation((value: AuthConfig) => {
    config = value;
    return { auth: authMock, handlers: {}, signIn: vi.fn(), signOut: vi.fn() };
  });
  await import('./auth');
  if (!config) throw new Error('NextAuth config was not captured');
  return config;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.user.findUnique.mockResolvedValue({
    name: 'Анна',
    locale: 'ru',
    emailVerified: new Date('2026-11-01T00:00:00Z'),
    suspendedAt: null,
    sessionSecurityVersion: 0,
  });
  authMock.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Issue #1 6.9: no hidden provider can be enabled by configuration', () => {
  test('SMTP configured for registration never becomes an email sign-in method', async () => {
    const config = await loadAuth(externalEnv);
    expect(config.providers.map((p) => p.id)).toEqual(['passkey']);
    expect(config.adapter).toBeUndefined();
    expect(config.session).toEqual({ strategy: 'jwt' });
    expect(config.providers.find((p) => p.id === 'passkey')).toBeDefined();
    expect(JSON.stringify(config.providers)).not.toContain('fake-smtp-secret');
    expect(JSON.stringify(config.providers)).not.toContain('fake-client');
    expect(JSON.stringify(config.providers)).not.toContain('fake-secret');
  });

  test('Google, OIDC and Magic Link remain absent for any old configuration', async () => {
    for (const env of [{}, externalEnv, { ...externalEnv, EMAIL_SERVER_HOST: '' }]) {
      const config = await loadAuth(env);
      const ids = config.providers.map((provider) => provider.id);
      expect(ids).toEqual(['passkey']);
      expect(ids).not.toContain('google');
      expect(ids).not.toContain('oidc');
      expect(ids).not.toContain('nodemailer');
      expect(config.adapter).toBeUndefined();
    }
  });

  test('the Passkey provider delegates only a one-time verified ticket to the session consumer', async () => {
    const config = await loadAuth(externalEnv);
    const passkey = config.providers.find((provider) => provider.id === 'passkey');
    expect(passkey).toBeDefined();
    expect(Object.keys((passkey?.credentials ?? {}) as object)).toEqual(['ticket']);
    const authorize = passkey?.authorize as (credentials: { ticket?: string; email?: string }) => Promise<unknown>;
    expect(typeof authorize).toBe('function');
    consumeTicket.mockResolvedValueOnce({
      id: 'verified-user',
      email: 'anna@example.ru',
      name: 'Анна',
      locale: 'ru',
    });
    expect(await authorize({ ticket: 'signed-and-consumed-proof' })).toMatchObject({ id: 'verified-user' });
    expect(consumeTicket).toHaveBeenCalledWith({ db, token: 'signed-and-consumed-proof' });
    consumeTicket.mockResolvedValueOnce(null);
    expect(await authorize({ email: 'anna@example.ru' })).toBeNull();
    expect(consumeTicket).toHaveBeenCalledWith({ db, token: undefined });
  });

  test('profile refresh remains supported without an external linking callback', async () => {
    const config = await loadAuth(externalEnv);
    const token = await config.callbacks.jwt({ token: {}, user: { id: 'user-1', name: 'Анна', locale: 'ru' } });
    expect(token).toMatchObject({
      id: 'user-1',
      name: 'Анна',
      locale: 'ru',
      sessionSecurityVersion: 0,
      sessionSecurityValid: true,
    });
    const session = config.callbacks.session({ session: { user: {} }, token });
    expect(session.user).toMatchObject({ id: 'user-1', name: 'Анна', locale: 'ru' });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        name: true,
        locale: true,
        emailVerified: true,
        suspendedAt: true,
        sessionSecurityVersion: true,
      },
    });
  });
});

describe('Issue #1 6.8.1.1: JWT revocation after recovery', () => {
  test('rejects all prior sessions after the database security version rotates', async () => {
    const config = await loadAuth();
    const previous = await config.callbacks.jwt({ token: {}, user: { id: 'user-1', name: 'Анна' } });
    expect(config.callbacks.session({ session: { user: {} }, token: previous }).user?.id).toBe('user-1');
    db.user.findUnique.mockResolvedValueOnce({
      name: 'Анна',
      locale: 'ru',
      emailVerified: new Date(),
      suspendedAt: null,
      sessionSecurityVersion: 1,
    });
    const invalidated = await config.callbacks.jwt({ token: previous });
    expect(invalidated.sessionSecurityValid).toBe(false);
    expect(config.callbacks.session({ session: { user: {} }, token: invalidated }).user).toBeUndefined();
  });

  test('rejects JWTs without an issued security version even if they contain a user id', async () => {
    const config = await loadAuth();
    const legacy = await config.callbacks.jwt({ token: { id: 'user-1', name: 'Анна' } });
    expect(legacy.sessionSecurityValid).toBe(false);
    expect(config.callbacks.session({ session: { user: {} }, token: legacy }).user).toBeUndefined();
  });

  test('fails closed during database outage and for suspended or unverified users', async () => {
    const config = await loadAuth();
    const token = await config.callbacks.jwt({ token: {}, user: { id: 'user-1' } });
    for (const state of [
      { name: 'Анна', locale: 'ru', emailVerified: null, suspendedAt: null, sessionSecurityVersion: 0 },
      { name: 'Анна', locale: 'ru', emailVerified: new Date(), suspendedAt: new Date(), sessionSecurityVersion: 0 },
      null,
    ]) {
      db.user.findUnique.mockResolvedValueOnce(state);
      const invalid = await config.callbacks.jwt({ token: { ...token } });
      expect(config.callbacks.session({ session: { user: {} }, token: invalid }).user).toBeUndefined();
    }
    db.user.findUnique.mockRejectedValueOnce(new Error('database unreachable'));
    const unavailable = await config.callbacks.jwt({ token: { ...token } });
    expect(config.callbacks.session({ session: { user: {} }, token: unavailable }).user).toBeUndefined();
  });

  test('a fresh verified Passkey ticket mints a JWT with the new security version', async () => {
    const config = await loadAuth();
    db.user.findUnique.mockResolvedValueOnce({
      name: 'Анна',
      locale: 'ru',
      emailVerified: new Date(),
      suspendedAt: null,
      sessionSecurityVersion: 3,
    });
    const renewed = await config.callbacks.jwt({ token: {}, user: { id: 'user-1' } });
    expect(renewed.sessionSecurityVersion).toBe(3);
    expect(config.callbacks.session({ session: { user: {} }, token: renewed }).user?.id).toBe('user-1');
  });
});
