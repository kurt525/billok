import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/trpc/router';
import { createTRPCContext } from '@/server/trpc/init';

// Bound the ACTUAL streamed body, not only Content-Length (which may be
// missing on chunked uploads or forged by a direct client). No complete body
// greater than 2 MiB is ever handed to tRPC/JSON parsing.
export const TRPC_MAX_POST_BYTES = 2 * 1024 * 1024;

export async function readBoundedTrpcRequest(req: Request): Promise<Request | null> {
  const reader = req.body?.getReader();
  if (!reader) return req;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > TRPC_MAX_POST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(req, { body });
}

const handler = async (req: Request) => {
  const checked = req.method === 'POST' ? await readBoundedTrpcRequest(req) : req;
  if (!checked)
    return new Response('Слишком большой запрос', { status: 413, headers: { 'Cache-Control': 'no-store' } });
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: checked,
    router: appRouter,
    createContext: () => createTRPCContext({ req: checked }),
  });
};

export { handler as GET, handler as POST };
