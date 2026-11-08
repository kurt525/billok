import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { queryRaw, authMock } = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  authMock: vi.fn(),
}));
vi.mock('@/server/db', () => ({ db: { $queryRawUnsafe: queryRaw } }));
vi.mock('@/server/auth', () => ({ auth: authMock }));

const PERSON_ID = '11111111-1111-4111-8111-111111111111';
const PERSON_TOKEN = '22222222-2222-4222-8222-222222222222';
const OTHER_TOKEN = '33333333-3333-4333-8333-333333333333';
const ownerId = 'owner-1';

function revision(
  version: string,
  options?: {
    personToken?: string;
    people?: { id: string; personToken: string }[];
    userId?: string | null;
    expiresAt?: Date;
  },
) {
  return [
    {
      version,
      expiresAt: options?.expiresAt ?? new Date(Date.now() + 86_400_000),
      userId: options?.userId === undefined ? ownerId : options.userId,
      people: options?.people ?? [{ id: PERSON_ID, personToken: options?.personToken ?? PERSON_TOKEN }],
    },
  ];
}

async function post(
  token = 'share-test',
  payload: unknown = { personId: PERSON_ID, personToken: PERSON_TOKEN },
  options?: { origin?: string; forwardedHost?: string; forwardedProto?: string },
) {
  const { POST } = await import('./route');
  return POST(
    new Request('http://localhost/api/guest/' + token + '/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options?.origin ? { Origin: options.origin } : {}),
        ...(options?.forwardedHost ? { 'x-forwarded-host': options.forwardedHost } : {}),
        ...(options?.forwardedProto ? { 'x-forwarded-proto': options.forwardedProto } : {}),
      },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ token }) },
  );
}

async function issueCookie(token = 'share-test', payload?: unknown) {
  const response = await post(token, payload ?? { personId: PERSON_ID, personToken: PERSON_TOKEN });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=strict');
  expect(cookie).not.toContain(PERSON_TOKEN);
  return cookie!.split(';')[0]!;
}

async function get(token = 'share-test', cookie?: string, signal?: AbortSignal) {
  const { GET } = await import('./route');
  return GET(
    new Request('http://localhost/api/guest/' + token + '/events', {
      ...(cookie ? { headers: { cookie } } : {}),
      ...(signal ? { signal } : {}),
    }),
    { params: Promise.resolve({ token }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', 'local-test-sse-hmac-secret-123456789');
  queryRaw.mockImplementation(async () => revision('100'));
  authMock.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('3.21: server-signed per-receipt authorization for SSE invalidations', () => {
  test('denies missing, guessed, expired and malformed credentials without revealing receipt existence', async () => {
    expect((await get('share-test')).status).toBe(404);
    expect((await get('x'.repeat(65))).status).toBe(404);
    expect(queryRaw).not.toHaveBeenCalled();
    expect((await post('x'.repeat(65))).status).toBe(404);
    expect((await post('share-test', { personId: PERSON_ID, personToken: OTHER_TOKEN })).status).toBe(404);
    expect((await post('share-test', {})).status).toBe(404);
    expect(
      (
        await post(
          'share-test',
          { personId: PERSON_ID, personToken: PERSON_TOKEN },
          {
            origin: 'https://attacker.invalid',
          },
        )
      ).status,
    ).toBe(403);
    const cookie = await issueCookie();
    expect((await get('another-receipt', cookie)).status).toBe(404);
    expect((await get('share-test', cookie + 'tampered')).status).toBe(404);
    expect((await get('share-test', 'billok_receipt_events=forged.signature')).status).toBe(404);
  });

  test('accepts trusted TLS reverse-proxy origin and issues a secure HttpOnly ticket', async () => {
    const response = await post(
      'share-proxy',
      { personId: PERSON_ID, personToken: PERSON_TOKEN },
      {
        origin: 'https://billok.ru',
        forwardedHost: 'billok.ru',
        forwardedProto: 'https',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
  });

  test('uses a guest secret only over POST; GET SSE emits no personal data, only change notifications', async () => {
    vi.useFakeTimers();
    const cookie = await issueCookie('share-live');
    queryRaw.mockResolvedValueOnce(revision('100')).mockResolvedValueOnce(revision('101'));
    const abort = new AbortController();
    const response = await get('share-live', cookie, abort.signal);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const ready = decoder.decode((await reader.read()).value);
    expect(ready).toContain('event: ready');
    expect(ready).toContain('retry: 2000');
    await vi.advanceTimersByTimeAsync(1500);
    const changed = decoder.decode((await reader.read()).value);
    expect(changed).toContain('event: changed');
    expect(changed).toContain('data: {}');
    expect(changed).not.toContain(PERSON_TOKEN);
    expect(changed).not.toContain(PERSON_ID);
    expect(changed).not.toContain('share-live');
    expect(queryRaw.mock.calls.every((call) => call[1] === 'share-live')).toBe(true);
    abort.abort();
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('rotating guest personal link revokes an already connected stream before sending a change', async () => {
    vi.useFakeTimers();
    const cookie = await issueCookie('revoked');
    queryRaw
      .mockResolvedValueOnce(revision('100'))
      .mockResolvedValueOnce(revision('101', { personToken: OTHER_TOKEN }))
      .mockResolvedValueOnce(revision('102', { personToken: OTHER_TOKEN }));
    const response = await get('revoked', cookie);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(1500);
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect((await get('revoked', cookie)).status).toBe(404);
  });

  test('creator may subscribe only to a receipt belonging to their authenticated account', async () => {
    authMock.mockResolvedValue({ user: { id: ownerId } });
    const cookie = await issueCookie('creator-sse', {});
    const response = await get('creator-sse', cookie);
    expect(response.status).toBe(200);
    await response.body!.cancel();
    authMock.mockResolvedValue({ user: { id: 'another-user' } });
    expect((await get('creator-sse', cookie)).status).toBe(404);
    expect((await post('creator-sse', {})).status).toBe(404);
  });

  test('closes revoked or deleted streams; reconnect must authorize again', async () => {
    vi.useFakeTimers();
    const cookie = await issueCookie('share-gone');
    queryRaw.mockResolvedValueOnce(revision('100')).mockResolvedValueOnce([]);
    const response = await get('share-gone', cookie);
    const reader = response.body!.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(1500);
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('releases stream resources on a database error or browser disconnect', async () => {
    vi.useFakeTimers();
    const cookie = await issueCookie('share-error');
    queryRaw.mockResolvedValueOnce(revision('100')).mockRejectedValueOnce(new Error('temporary outage'));
    const response = await get('share-error', cookie);
    const reader = response.body!.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(1500);
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('bounds authorized connections, and releases capacity after a browser closes', async () => {
    vi.useFakeTimers();
    const cookie = await issueCookie('same-receipt');
    const open = [];
    for (let i = 0; i < 32; i++) {
      const response = await get('same-receipt', cookie);
      expect(response.status).toBe(200);
      open.push(response.body!.getReader());
    }
    const limited = await get('same-receipt', cookie);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('3');
    await open[0]!.cancel();
    const recovered = await get('same-receipt', cookie);
    expect(recovered.status).toBe(200);
    await recovered.body!.cancel();
    for (const reader of open.slice(1)) await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
