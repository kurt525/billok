import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppError } from '../../lib/app-error';

vi.mock('next/headers', () => ({
  cookies: vi.fn().mockResolvedValue({ get: vi.fn().mockReturnValue(null) }),
}));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
const { cleanupGate, confirmationGate, signupGate, resendLimiter, resendEligibility, resendDelivery } = vi.hoisted(
  () => ({
    cleanupGate: vi.fn(),
    confirmationGate: vi.fn(),
    signupGate: vi.fn(),
    resendLimiter: vi.fn(),
    resendEligibility: vi.fn(),
    resendDelivery: vi.fn(),
  }),
);
vi.mock('../../lib/registration-cleanup-trigger', () => ({ runRegistrationCleanupIfDue: cleanupGate }));
vi.mock('../../lib/registration-email-confirmation', () => ({ confirmRegistrationEmail: confirmationGate }));
vi.mock('../../lib/registration-invite-delivery', () => ({ createAndDeliverPendingInviteRegistration: signupGate }));
vi.mock('../../lib/registration-resend-rate-limit', () => ({ allowRegistrationVerificationResend: resendLimiter }));
vi.mock('../../lib/registration-resend-eligibility', () => ({ findPendingRegistrationForResend: resendEligibility }));
vi.mock('../../lib/registration-resend-delivery', () => ({ deliverPendingVerificationResend: resendDelivery }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('hashed'), compare: vi.fn() },
}));

const mockDb = {
  systemSetting: { findUnique: vi.fn() },
  systemInvite: { findUnique: vi.fn() },
  user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
};
vi.mock('@/server/db', () => ({ db: mockDb }));
vi.mock('@/server/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const OIDC_ENV = {
  OIDC_ISSUER: 'https://auth.example.com/application/o/sharetab/',
  OIDC_CLIENT_ID: 'sharetab',
  OIDC_CLIENT_SECRET: 's3cret',
  OIDC_DISPLAY_NAME: 'Authentik',
};

async function caller(session: { user: { id: string } } | null = null, headers = new Headers()) {
  const { authRouter } = await import('./auth');
  const ctx = { session, db: mockDb, headers, impersonating: null };
  return authRouter.createCaller(ctx as unknown as Parameters<typeof authRouter.createCaller>[0]);
}

function stubEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  cleanupGate.mockResolvedValue(undefined);
  confirmationGate.mockResolvedValue(true);
  signupGate.mockResolvedValue({ email: 'ada@mail.ru', expiresAt: new Date('2026-11-01T12:30:00Z') });
  resendLimiter.mockReturnValue(true);
  resendEligibility.mockResolvedValue(null);
  resendDelivery.mockResolvedValue({ requestId: 'replacement-1', expiresAt: new Date('2026-11-01T12:30:00Z') });
  vi.stubEnv('REGISTER_RATE_LIMIT_MAX', '9999');
  // Start from a clean auth env regardless of the developer's .env
  for (const key of [
    ...Object.keys(OIDC_ENV),
    'DISABLE_PASSWORD_LOGIN',
    'EMAIL_SERVER_HOST',
    'EMAIL_SERVER_PORT',
    'EMAIL_SERVER_USER',
    'EMAIL_SERVER_PASSWORD',
    'EMAIL_FROM',
    'NEXTAUTH_URL',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
  ]) {
    vi.stubEnv(key, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('auth.getLoginOptions', () => {
  test('defaults to password login only', async () => {
    const api = await caller();
    expect(await api.getLoginOptions()).toEqual({ passwordLogin: true, magicLink: false, oidc: null, google: false });
  });

  test('exposes the OIDC button name but never the issuer or secret', async () => {
    stubEnv({ ...OIDC_ENV, EMAIL_SERVER_HOST: 'smtp.example.com', DISABLE_PASSWORD_LOGIN: 'true' });
    const api = await caller();
    const options = await api.getLoginOptions();
    expect(options).toEqual({ passwordLogin: false, magicLink: true, oidc: { name: 'Authentik' }, google: false });
    expect(JSON.stringify(options)).not.toContain('s3cret');
    expect(JSON.stringify(options)).not.toContain('auth.example.com');
  });

  test('reports Google when configured, without its client id or secret', async () => {
    stubEnv({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'g-secret' });
    const api = await caller();
    const options = await api.getLoginOptions();
    expect(options).toEqual({ passwordLogin: true, magicLink: false, oidc: null, google: true });
    expect(JSON.stringify(options)).not.toContain('g-secret');
    expect(JSON.stringify(options)).not.toContain('googleusercontent');
  });

  test('a partial Google config shows no Google button', async () => {
    stubEnv({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com' });
    const api = await caller();
    expect((await api.getLoginOptions()).google).toBe(false);
  });
});

describe('auth.confirmEmail', () => {
  const token = 'A'.repeat(43);

  test('confirms through the transactional service without signing in or returning tokens', async () => {
    const api = await caller();
    const response = await api.confirmEmail({ token });
    expect(response).toEqual({ verified: true });
    expect(confirmationGate).toHaveBeenCalledExactlyOnceWith(mockDb, token);
    expect(JSON.stringify(response)).not.toContain(token);
  });

  test('returns the same error for missing, consumed or expired links', async () => {
    confirmationGate.mockResolvedValue(false);
    const api = await caller();
    await expect(api.confirmEmail({ token })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(confirmationGate).toHaveBeenCalledExactlyOnceWith(mockDb, token);
  });

  test('rejects empty input before reaching the confirmation service', async () => {
    const api = await caller();
    await expect(api.confirmEmail({ token: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(confirmationGate).not.toHaveBeenCalled();
  });

  test('limits repeated confirmation attempts before calling the service', async () => {
    vi.stubEnv('EMAIL_CONFIRM_RATE_LIMIT_MAX', '2');
    const headers = new Headers({ 'x-real-ip': '192.0.2.146' });
    const api = await caller(null, headers);
    await api.confirmEmail({ token });
    await api.confirmEmail({ token });
    await expect(api.confirmEmail({ token })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(confirmationGate).toHaveBeenCalledTimes(2);
  });
});

describe('auth.resendRegistrationVerification', () => {
  const email = 'person@mail.ru';
  const pending = { userId: 'pending-1', inviteCode: 'my-invite', email };
  const config = {
    NEXTAUTH_URL: 'https://billok.ru',
    EMAIL_SERVER_HOST: 'smtp.reg.ru',
    EMAIL_SERVER_PORT: '465',
    EMAIL_SERVER_USER: 'noreply@billok.ru',
    EMAIL_SERVER_PASSWORD: 'smtp-test-only',
    EMAIL_FROM: 'BillOK <noreply@billok.ru>',
  };

  test('returns the same acknowledgement for unknown and eligible addresses', async () => {
    stubEnv(config);
    const api = await caller();
    const unknown = await api.resendRegistrationVerification({ email });
    expect(unknown).toEqual({ accepted: true });
    expect(resendDelivery).not.toHaveBeenCalled();

    resendEligibility.mockResolvedValueOnce(pending);
    const eligible = await api.resendRegistrationVerification({ email });
    expect(eligible).toEqual(unknown);
    expect(resendDelivery).toHaveBeenCalledExactlyOnceWith({
      db: mockDb,
      ...pending,
      siteOrigin: 'https://billok.ru',
      from: config.EMAIL_FROM,
      server: {
        host: 'smtp.reg.ru',
        port: 465,
        secure: true,
        requireTLS: false,
        auth: { user: config.EMAIL_SERVER_USER, pass: config.EMAIL_SERVER_PASSWORD },
      },
    });
    expect(JSON.stringify(eligible)).not.toContain('my-invite');
    expect(JSON.stringify(eligible)).not.toContain(email);
  });

  test('does not look up accounts when the rate limit is exceeded', async () => {
    stubEnv(config);
    resendLimiter.mockReturnValueOnce(false);
    const api = await caller();
    await expect(api.resendRegistrationVerification({ email })).resolves.toEqual({ accepted: true });
    expect(resendEligibility).not.toHaveBeenCalled();
    expect(resendDelivery).not.toHaveBeenCalled();
  });

  test('skips delivery for disallowed domain endings', async () => {
    stubEnv(config);
    const api = await caller();
    await expect(api.resendRegistrationVerification({ email: 'person@example.com' })).resolves.toEqual({
      accepted: true,
    });
    expect(resendEligibility).not.toHaveBeenCalled();
    expect(resendDelivery).not.toHaveBeenCalled();
  });

  test('does not look up accounts or send without SMTP configuration', async () => {
    const api = await caller();
    await expect(api.resendRegistrationVerification({ email })).resolves.toEqual({ accepted: true });
    expect(resendEligibility).not.toHaveBeenCalled();
    expect(resendDelivery).not.toHaveBeenCalled();
  });

  test('does not disclose SMTP failures or create an authenticated session', async () => {
    stubEnv(config);
    resendEligibility.mockResolvedValueOnce(pending);
    resendDelivery.mockRejectedValueOnce(new Error('SMTP failure'));
    const api = await caller();
    await expect(api.resendRegistrationVerification({ email })).resolves.toEqual({ accepted: true });
    expect(resendDelivery).toHaveBeenCalledOnce();
    expect(mockDb.user.create).not.toHaveBeenCalled();
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });
});

describe('password login disabled', () => {
  beforeEach(() => {
    stubEnv({ ...OIDC_ENV, DISABLE_PASSWORD_LOGIN: 'true' });
  });

  test('register is refused before touching the database', async () => {
    const api = await caller();
    await expect(
      api.register({ name: 'Alice', email: 'alice@example.com', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Registration is currently closed.' });
    expect(mockDb.systemSetting.findUnique).not.toHaveBeenCalled();
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(cleanupGate).not.toHaveBeenCalled();
  });

  test('getRegistrationMode reports closed regardless of the admin setting', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'registrationMode', value: 'open' });
    const api = await caller();
    expect(await api.getRegistrationMode()).toEqual({ mode: 'closed' });
  });
});

const EMAIL_ENV = {
  NEXTAUTH_URL: 'https://billok.ru',
  EMAIL_SERVER_HOST: 'smtp.reg.ru',
  EMAIL_SERVER_PORT: '465',
  EMAIL_SERVER_USER: 'noreply@billok.ru',
  EMAIL_SERVER_PASSWORD: 'smtp-test-only',
  EMAIL_FROM: 'BillOK <noreply@billok.ru>',
};

describe('auth.register invite-only email confirmation', () => {
  test('requires an invite code even if the stored setting is open', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue(null);
    const api = await caller();
    await expect(api.register({ name: 'Ada', email: 'ada@mail.ru', password: 'password123' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'An invite code is required to register.',
    });
    expect(signupGate).not.toHaveBeenCalled();
  });

  test.each(['ada@example.com', 'ada@mail.ru.evil.com', 'ada@mail.рф'])(
    'rejects a registration email outside the permitted .ru/.su zones: %s',
    async (email) => {
      mockDb.systemSetting.findUnique.mockResolvedValue(null);
      const api = await caller();
      await expect(
        api.register({ name: 'Ada', email, password: 'password123', inviteCode: 'valid' }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(signupGate).not.toHaveBeenCalled();
    },
  );

  test('fails closed when SMTP is not configured before creating a pending account', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue(null);
    const api = await caller();
    await expect(
      api.register({ name: 'Ada', email: 'ada@mail.ru', password: 'password123', inviteCode: 'valid' }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(signupGate).not.toHaveBeenCalled();
    expect(cleanupGate).not.toHaveBeenCalled();
  });

  test('still rejects emails that already exist with different letter case', async () => {
    stubEnv(EMAIL_ENV);
    mockDb.systemSetting.findUnique.mockResolvedValue(null);
    mockDb.$queryRaw.mockResolvedValue([{ id: 'bob' }]);
    mockDb.user.findMany.mockResolvedValue([{ id: 'bob', email: 'Bob@mail.ru' }]);
    const api = await caller();
    await expect(
      api.register({ name: 'Mallory', email: 'bob@mail.ru', password: 'password123', inviteCode: 'valid' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(signupGate).not.toHaveBeenCalled();
    expect(cleanupGate).toHaveBeenCalledExactlyOnceWith(mockDb);
  });

  test.each(['ada@mail.ru', 'ada@mail.su'])(
    'sends only a pending confirmation response for %s; never signs in or returns the password hash',
    async (email) => {
      stubEnv(EMAIL_ENV);
      mockDb.systemSetting.findUnique.mockResolvedValue(null);
      mockDb.$queryRaw.mockResolvedValue([]);
      signupGate.mockResolvedValue({ email, expiresAt: new Date('2026-11-01T12:30:00Z') });
      const api = await caller();
      const response = await api.register({
        name: '  Ada  ',
        email,
        password: 'password123',
        inviteCode: 'valid',
      });
      expect(response).toEqual({ email, verificationRequired: true });
      expect(signupGate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          db: mockDb,
          name: 'Ada',
          email,
          passwordHash: 'hashed',
          inviteCode: 'valid',
          siteOrigin: 'https://billok.ru',
          from: 'BillOK <noreply@billok.ru>',
          server: expect.objectContaining({ secure: true }),
        }),
      );
      expect(JSON.stringify(response)).not.toContain('hashed');
    },
  );

  test('keeps concurrent invite rejection and unique email conflict errors distinct from mail failures', async () => {
    stubEnv(EMAIL_ENV);
    mockDb.systemSetting.findUnique.mockResolvedValue({ value: 'invite-only' });
    mockDb.$queryRaw.mockResolvedValue([]);
    const api = await caller();
    signupGate.mockRejectedValueOnce(new AppError('FORBIDDEN', 'inviteCodeInvalid'));
    await expect(
      api.register({ name: 'Ada', email: 'ada@mail.ru', password: 'password123', inviteCode: 'claimed' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Invalid or expired invite code.' });
    signupGate.mockRejectedValueOnce(new AppError('CONFLICT', 'emailTaken'));
    await expect(
      api.register({ name: 'Ada', email: 'ada@mail.ru', password: 'password123', inviteCode: 'valid' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    signupGate.mockRejectedValueOnce(new Error('secret SMTP detail'));
    await expect(
      api.register({ name: 'Ada', email: 'ada@mail.ru', password: 'password123', inviteCode: 'valid' }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('names are trimmed', () => {
  test('register refuses a name that is only whitespace', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue(null);
    mockDb.$queryRaw.mockResolvedValue([]);
    const api = await caller();
    await expect(api.register({ name: '   ', email: 'ws@example.com', password: 'password123' })).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      },
    );
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('updateProfile refuses a name that is only whitespace', async () => {
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
    const api = await caller({ user: { id: 'u1' } });
    await expect(api.updateProfile({ name: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  test('updateProfile stores the name without surrounding whitespace', async () => {
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
    mockDb.user.update.mockResolvedValue({ id: 'u1', name: 'Ada', email: 'ada@example.com' });
    const api = await caller({ user: { id: 'u1' } });
    await api.updateProfile({ name: '  Ada  ' });
    expect(mockDb.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Ada' } }));
  });
});

describe('auth.updateProfile SBP details', () => {
  test('saves normalized phone and selected bank for signed-in user', async () => {
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
    mockDb.user.update.mockResolvedValue({
      id: 'u1',
      name: 'Ada',
      sbpPhone: '+79991234567',
      sbpBankId: 'tbank',
    });
    const api = await caller({ user: { id: 'u1' } });
    const updated = await api.updateProfile({ sbpPhone: '8 (999) 123-45-67', sbpBankId: 'tbank' });
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1' }, data: { sbpPhone: '+79991234567', sbpBankId: 'tbank' } }),
    );
    expect(updated).toMatchObject({ sbpPhone: '+79991234567', sbpBankId: 'tbank' });
  });

  test('invalid phone and unknown bank never reach the database update', async () => {
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
    const api = await caller({ user: { id: 'u1' } });
    await expect(api.updateProfile({ sbpPhone: '+15551234567' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.updateProfile({ sbpBankId: 'fake-bank' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });

  test('both fields can be cleared and anonymous updates are rejected', async () => {
    mockDb.user.findUnique.mockResolvedValue({ suspendedAt: null });
    mockDb.user.update.mockResolvedValue({ id: 'u1', sbpPhone: null, sbpBankId: null });
    const signedIn = await caller({ user: { id: 'u1' } });
    await signedIn.updateProfile({ sbpPhone: '', sbpBankId: null });
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sbpPhone: null, sbpBankId: null } }),
    );
    mockDb.user.update.mockClear();
    await expect((await caller()).updateProfile({ sbpPhone: '+79991234567' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mockDb.user.update).not.toHaveBeenCalled();
  });
});

describe('password login enabled', () => {
  test('getRegistrationMode returns the admin setting', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'registrationMode', value: 'invite-only' });
    const api = await caller();
    expect(await api.getRegistrationMode()).toEqual({ mode: 'invite-only' });
  });

  test('getRegistrationMode treats legacy open settings as invitation-only', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'registrationMode', value: 'something-else' });
    const api = await caller();
    expect(await api.getRegistrationMode()).toEqual({ mode: 'invite-only' });
  });

  test('register is refused while the setting is closed', async () => {
    stubEnv({ REGISTER_RATE_LIMIT_MAX: '9999' });
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'registrationMode', value: 'closed' });
    const api = await caller();
    await expect(
      api.register({ name: 'Ada', email: 'ada@example.com', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  test('registration cannot bypass the invitation even with a legacy open setting', async () => {
    mockDb.systemSetting.findUnique.mockResolvedValue({ key: 'registrationMode', value: 'something-else' });
    const api = await caller();
    await expect(api.register({ name: 'Ada', email: 'ada@mail.ru', password: 'password123' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(signupGate).not.toHaveBeenCalled();
  });
});

describe('auth.getProfile', () => {
  test('reports whether the user has a password without returning the hash', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      name: 'Alice',
      email: 'alice@example.com',
      venmoUsername: null,
      locale: 'en',
      defaultCurrency: 'USD',
      passwordHash: 'hashed',
    });
    const api = await caller({ user: { id: 'user-1' } });
    const profile = await api.getProfile();
    expect(profile.hasPassword).toBe(true);
    expect(profile).not.toHaveProperty('passwordHash');
  });

  test("returns the caller's id, so the client can tell who tRPC acts as while impersonating", async () => {
    mockDb.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Alice',
      email: 'alice@example.com',
      passwordHash: null,
    });
    const api = await caller({ user: { id: 'user-1' } });
    await api.getProfile();
    expect(mockDb.user.findUnique).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'user-1' }, select: expect.objectContaining({ id: true }) }),
    );
  });

  test('hasPassword is false for OIDC-only users', async () => {
    mockDb.user.findUnique.mockResolvedValue({
      name: 'Alice',
      email: 'alice@example.com',
      venmoUsername: null,
      locale: 'en',
      defaultCurrency: 'USD',
      passwordHash: null,
    });
    const api = await caller({ user: { id: 'user-1' } });
    expect((await api.getProfile()).hasPassword).toBe(false);
  });
});
