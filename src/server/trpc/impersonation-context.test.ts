import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { signPayload } from '@/server/lib/signed-cookie';

const { authMock, cookiesMock, bindingMock, dbMock, store } = vi.hoisted(() => ({
  authMock: vi.fn(),
  cookiesMock: vi.fn(),
  bindingMock: vi.fn(),
  dbMock: {},
  store: { signed: '' },
}));
vi.mock('../auth', () => ({ auth: authMock }));
vi.mock('../db', () => ({ db: dbMock }));
vi.mock('next/headers', () => ({ cookies: cookiesMock }));
vi.mock('../lib/impersonation-session', async (original) => {
  const actual = await original<typeof import('../lib/impersonation-session')>();
  return { ...actual, currentImpersonationSessionBinding: bindingMock };
});

const owner = 'owner-1';
const target = 'other-user-1';
const fingerprint = 'b'.repeat(42) + 'g';
const req = () =>
  new Request('https://billok.ru/api/trpc/admin.getImpersonationStatus', {
    headers: { cookie: 'authjs.session-token=owner-session' },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', 'test-auth-secret-for-impersonation-context-12345678');
  authMock.mockImplementation(async () => ({ user: { id: owner, email: 'owner@example.ru', name: 'Владелец' } }));
  bindingMock.mockResolvedValue(fingerprint);
  cookiesMock.mockImplementation(async () => ({
    get: () => ({ value: store.signed }),
  }));
  store.signed = signPayload(
    JSON.stringify({
      adminId: owner,
      adminEmail: 'owner@example.ru',
      targetId: target,
      targetName: 'Анна',
      targetEmail: 'anna@example.ru',
      startedAt: new Date().toISOString(),
      sessionBinding: fingerprint,
    }),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('Issue 6.12.3: tRPC identity under impersonation', () => {
  test('only a valid same-login cookie can switch the effective user; original owner session is not modified', async () => {
    const { createTRPCContext } = await import('./init');
    const ctx = await createTRPCContext({ req: req() });
    expect(ctx.impersonating).toMatchObject({ adminId: owner, targetId: target });
    expect(ctx.session?.user).toMatchObject({ id: target, email: 'anna@example.ru' });
    expect(bindingMock).toHaveBeenCalledWith(expect.any(Request), owner);
    expect((await authMock.mock.results[0]?.value).user.id).toBe(owner);
  });

  test('another login or a tampered/expired cookie never changes the owner context', async () => {
    const { createTRPCContext } = await import('./init');
    bindingMock.mockResolvedValueOnce('c'.repeat(42) + 'w');
    const replay = await createTRPCContext({ req: req() });
    expect(replay.impersonating).toBeNull();
    expect(replay.session?.user?.id).toBe(owner);
    store.signed = store.signed.replace(target, 'forged-target');
    const tampered = await createTRPCContext({ req: req() });
    expect(tampered.impersonating).toBeNull();
    expect(tampered.session?.user?.id).toBe(owner);
    const missingRequest = await createTRPCContext();
    expect(missingRequest.impersonating).toBeNull();
    expect(missingRequest.session?.user?.id).toBe(owner);
  });
});
