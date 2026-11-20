import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { fetchHandler, createContext } = vi.hoisted(() => ({
  fetchHandler: vi.fn(),
  createContext: vi.fn(),
}));
vi.mock('@trpc/server/adapters/fetch', () => ({ fetchRequestHandler: fetchHandler }));
vi.mock('@/server/trpc/router', () => ({ appRouter: {} }));
vi.mock('@/server/trpc/init', () => ({ createTRPCContext: createContext }));

const base = 'https://billok.ru/api/trpc/auth.updateProfile';

function post(chunks: Uint8Array[]) {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) controller.close();
      else controller.enqueue(chunks[i++]!);
    },
  });
  return new Request(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    // Node's streamed requests require duplex; plain RequestInit omits it.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchHandler.mockImplementation(async ({ req }: { req: Request }) => {
    await req.text();
    return new Response('ok', { status: 200 });
  });
});
afterEach(() => vi.restoreAllMocks());

describe('Issue 6.12.6: bounded tRPC mutations cannot bypass limits using chunked bodies', () => {
  test('accepts a streaming JSON POST and passes the same checked request into Auth.js context', async () => {
    const { POST } = await import('./route');
    const content = new TextEncoder().encode(JSON.stringify({ name: 'Илья' }));
    expect((await POST(post([content.subarray(0, 6), content.subarray(6)]))).status).toBe(200);
    expect(fetchHandler).toHaveBeenCalledOnce();
    const args = fetchHandler.mock.calls[0]![0];
    expect(args.req.url).toBe(base);
    expect(args.req.headers.get('content-type')).toBe('application/json');
    await args.createContext();
    expect(createContext).toHaveBeenCalledWith({ req: args.req });
  });

  test('rejects oversized unknown-length streamed POST without reaching router or session', async () => {
    const { POST, TRPC_MAX_POST_BYTES } = await import('./route');
    const bytes = new Uint8Array(1024 * 1024);
    const response = await POST(post([bytes, bytes, new Uint8Array(1)]));
    expect(response.status).toBe(413);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetchHandler).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(TRPC_MAX_POST_BYTES).toBe(2_097_152);
  });

  test('accepts the exact limit, rejects one byte beyond it', async () => {
    const { POST, TRPC_MAX_POST_BYTES } = await import('./route');
    const bytes = new Uint8Array(TRPC_MAX_POST_BYTES);
    expect((await POST(post([bytes]))).status).toBe(200);
    expect(fetchHandler).toHaveBeenCalledOnce();
    fetchHandler.mockClear();
    expect((await POST(post([bytes, new Uint8Array(1)]))).status).toBe(413);
    expect(fetchHandler).not.toHaveBeenCalled();
  });

  test('GET queries do not consume or rewrite the body', async () => {
    const { GET } = await import('./route');
    const req = new Request(base);
    expect((await GET(req)).status).toBe(200);
    expect(fetchHandler.mock.calls[0]![0].req).toBe(req);
  });
});
