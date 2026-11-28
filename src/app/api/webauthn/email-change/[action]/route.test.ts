import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
const f = vi.hoisted(() => ({
  auth: vi.fn(),
  token: vi.fn(),
  start: vi.fn(),
  approve: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
  audit: vi.fn(),
  rate: vi.fn(),
  after: vi.fn(),
  maintenance: vi.fn(),
}));
vi.mock('next/server', () => ({ after: f.after }));
vi.mock('next-auth/jwt', () => ({ getToken: f.token }));
vi.mock('@/server/auth', () => ({ auth: f.auth }));
vi.mock('@/server/db', () => ({ db: { securityEvent: { create: f.audit } } }));
vi.mock('@/server/lib/rate-limit', () => ({ checkRateLimit: f.rate, checkTokenRateLimit: f.rate }));
vi.mock('@/server/lib/email-change-notification', () => ({ processEmailChangeNotifications: f.maintenance }));
vi.mock('@/server/lib/email-change', () => ({
  beginEmailChange: f.start,
  approveEmailChange: f.approve,
  completeEmailChange: f.complete,
  cancelEmailChange: f.cancel,
  emailChangeStatus: f.status,
  emailChangeDigest: (v: string) => 'hash:' + v,
}));
const id = '11111111-1111-4111-8111-111111111111';
const payload = { email: 'new@mail.ru' };
const cookie = 'authjs.session-token=verified-qa-cookie';
function request(action: string, data: unknown = payload, headers: Record<string, string> = {}, suffix = '') {
  return POST(
    new Request('https://billok.ru/api/webauthn/email-change/' + action + suffix, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://billok.ru', Cookie: cookie, ...headers },
      body: JSON.stringify(data),
    }),
    { params: Promise.resolve({ action }) },
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(48));
  vi.stubEnv('BILLOK_WEBAUTHN_ORIGIN', 'https://billok.ru');
  vi.stubEnv('BILLOK_WEBAUTHN_RP_ID', 'billok.ru');
  f.auth.mockResolvedValue({ user: { id } });
  f.token.mockResolvedValue({
    id,
    sessionSecurityValid: true,
    sessionSecurityVersion: 3,
    impersonationSessionNonce: 'a'.repeat(43),
  });
  f.rate.mockReturnValue({ allowed: true });
  f.start.mockResolvedValue({ challenge: 'mock-options' });
  f.approve.mockResolvedValue({ delivered: true });
  f.complete.mockResolvedValue({ changed: true });
  f.cancel.mockResolvedValue({ cancelled: true });
  f.status.mockResolvedValue({ allowed: true, owner: false, pending: null });
  f.audit.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());
describe('TASK-BILLOK-012 — route authorization', () => {
  it('uses only verified JWT identity, version and stable domain-separated session binding', async () => {
    const r = await request('start');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(f.start).toHaveBeenCalledWith(
      expect.objectContaining({
        email: payload.email,
        session: { userId: id, version: 3, binding: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      }),
    );
    const first = f.start.mock.calls[0]![0].session.binding;
    await request('start', payload, { Cookie: 'authjs.session-token=renewed-cookie' });
    expect(f.start.mock.calls[1]![0].session.binding).toBe(first);
    f.token.mockResolvedValue({
      id,
      sessionSecurityValid: true,
      sessionSecurityVersion: 3,
      impersonationSessionNonce: 'b'.repeat(43),
    });
    await request('start');
    expect(f.start.mock.calls[2]![0].session.binding).not.toBe(first);
  });
  it.each([
    { Origin: 'https://evil.invalid' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Content-Type': 'text/plain' },
    { Cookie: 'sharetab-impersonate=bad; ' + cookie },
    { Cookie: cookie + '; __Secure-authjs.session-token=ambiguous' },
    { Cookie: '' },
  ])('refuses untrusted requests or impersonation (%j)', async (headers) => {
    expect((await request('start', payload, headers)).status).toBe(403);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('rejects anonymous, mismatched and stale JWTs before calling the service', async () => {
    f.auth.mockResolvedValueOnce(null);
    expect((await request('start')).status).toBe(403);
    for (const override of [
      { id: 'foreign' },
      { sessionSecurityValid: false },
      { sessionSecurityVersion: undefined },
      { impersonationSessionNonce: 'bad' },
    ]) {
      f.token.mockResolvedValueOnce({
        id,
        sessionSecurityValid: true,
        sessionSecurityVersion: 3,
        impersonationSessionNonce: 'a'.repeat(43),
        ...override,
      });
      expect((await request('start')).status).toBe(403);
    }
    expect(f.start).not.toHaveBeenCalled();
  });
  it('rejects arbitrary input keys and query tokens', async () => {
    expect((await request('start', { ...payload, userId: 'another' })).status).toBe(400);
    expect((await request('complete', { token: 'X'.repeat(43) }, {}, '?token=forbidden')).status).toBe(403);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    for (const [args] of f.audit.mock.calls) expect(JSON.stringify(args)).not.toContain('new@mail.ru');
  });
  it('rejects oversized JSON even if the request claims a small length', async () => {
    expect((await request('approve', { response: { id: 'a'.repeat(25_000) } }, { 'Content-Length': '1' })).status).toBe(
      400,
    );
    expect(f.approve).not.toHaveBeenCalled();
  });
  it('uses separate state-changing POSTs and handles committed completion independently of scheduling', async () => {
    expect((await request('approve', { response: { id: 'qa' } })).status).toBe(200);
    f.after.mockImplementationOnce(() => {
      throw new Error('schedule unavailable');
    });
    expect(await (await request('complete', { token: 'X'.repeat(43) })).json()).toEqual({ changed: true });
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect((await request('cancel', {})).status).toBe(200);
    expect((await request('status', {})).status).toBe(200);
    expect((await request('unknown', {})).status).toBe(404);
  });
  it('limits requests before any sensitive action', async () => {
    f.rate.mockReturnValue({ allowed: false });
    expect((await request('start')).status).toBe(429);
    expect(f.start).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalled();
  });
});
