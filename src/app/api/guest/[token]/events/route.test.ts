import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('@/server/db', () => ({ db: { $queryRawUnsafe: queryRaw } }));

async function get(token = 'share-test', signal?: AbortSignal) {
  const { GET } = await import('./route');
  return GET(new Request('http://localhost/api/guest/' + token + '/events', signal ? { signal } : undefined), {
    params: Promise.resolve({ token }),
  });
}

function revision(version: string) {
  return [{ version, expiresAt: new Date(Date.now() + 86_400_000) }];
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('3.16: SSE is an invalidation signal over the saved receipt', () => {
  test('rejects missing, oversized and expired share links without opening streams', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get('x'.repeat(65))).status).toBe(400);
    queryRaw.mockResolvedValueOnce([]);
    expect((await get('missing')).status).toBe(404);
    queryRaw.mockResolvedValueOnce([{ version: 'v1', expiresAt: new Date(0) }]);
    expect((await get('expired')).status).toBe(404);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  test('delivers a committed version, rechecks the DB, and never emits private data', async () => {
    vi.useFakeTimers();
    queryRaw.mockResolvedValueOnce(revision('100')).mockResolvedValueOnce(revision('101'));
    const abort = new AbortController();
    const response = await get('share-live', abort.signal);
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
    expect(changed).not.toContain('share-live');
    expect(queryRaw.mock.calls[0]?.[1]).toBe('share-live');
    expect(queryRaw.mock.calls[1]?.[1]).toBe('share-live');
    abort.abort();
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('closes an interrupted stream so EventSource can reconnect and recheck current state', async () => {
    vi.useFakeTimers();
    queryRaw.mockResolvedValueOnce(revision('100')).mockRejectedValueOnce(new Error('temporary outage'));
    const response = await get('share-live');
    const reader = response.body!.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(1500);
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('bounds persistent connections, then releases the slot after a browser closes', async () => {
    vi.useFakeTimers();
    queryRaw.mockImplementation(async () => revision('100'));
    const open = [];
    for (let i = 0; i < 32; i++) {
      const response = await get('same-receipt');
      expect(response.status).toBe(200);
      open.push(response.body!.getReader());
    }
    const limited = await get('same-receipt');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('3');
    await open[0]!.cancel();
    const recovered = await get('same-receipt');
    expect(recovered.status).toBe(200);
    await recovered.body!.cancel();
    for (const reader of open.slice(1)) await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('notifies deletion or expiry and closes the stream', async () => {
    vi.useFakeTimers();
    queryRaw.mockResolvedValueOnce(revision('100')).mockResolvedValueOnce([]);
    const response = await get('share-gone');
    const reader = response.body!.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(1500);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: gone');
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
