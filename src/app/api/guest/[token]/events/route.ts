import { db } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A committed PostgreSQL row version changes even when updates share a
// millisecond. Only send invalidations, never personal or payment details.
async function sessionRevision(token: string) {
  const rows = await db.$queryRawUnsafe<{ version: string; expiresAt: Date }[]>(
    'SELECT xmin::text AS "version", "expiresAt" FROM "GuestSplit" WHERE "shareToken" = $1 LIMIT 1',
    token,
  );
  return rows[0] ?? null;
}

const CHECK_MS = 1500;
const HEARTBEAT_EVERY = 8;
const RECONNECT_MS = 2000;
const MAX_SPLIT_STREAMS = 32;
const MAX_TOTAL_STREAMS = 256;
const streamsPerToken = new Map<string, number>();
let allStreams = 0;

// Limit persistent connections on small self-hosted installations. Each
// connection must release its slot on browser cancellation and DB failure.
function reserveStream(token: string): (() => void) | null {
  const count = streamsPerToken.get(token) ?? 0;
  if (count >= MAX_SPLIT_STREAMS || allStreams >= MAX_TOTAL_STREAMS) return null;
  streamsPerToken.set(token, count + 1);
  allStreams++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    allStreams--;
    const remaining = (streamsPerToken.get(token) ?? 1) - 1;
    if (remaining > 0) streamsPerToken.set(token, remaining);
    else streamsPerToken.delete(token);
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length > 64) return new Response(null, { status: 400 });
  const initial = await sessionRevision(token);
  if (!initial || initial.expiresAt <= new Date()) return new Response(null, { status: 404 });
  const release = reserveStream(token);
  if (!release) return new Response(null, { status: 429, headers: { 'Retry-After': '3' } });

  const encoder = new TextEncoder();
  let stopStream: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let revision = initial.version;
      let ticks = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        release();
        request.signal.removeEventListener('abort', stop);
        try {
          controller.close();
        } catch {
          // The browser already canceled this response.
        }
      };
      stopStream = stop;
      const send = (payload: string) => {
        if (!closed && !request.signal.aborted) controller.enqueue(encoder.encode(payload));
      };
      const check = async () => {
        if (closed || request.signal.aborted) return stop();
        try {
          const current = await sessionRevision(token);
          if (!current || current.expiresAt <= new Date()) {
            send('event: gone\ndata: {}\n\n');
            return stop();
          }
          if (current.version !== revision) {
            revision = current.version;
            send('event: changed\ndata: {}\n\n');
          } else if (++ticks % HEARTBEAT_EVERY === 0) {
            send(': keepalive\n\n');
          }
        } catch {
          // Force EventSource reconnect + client fallback on a DB outage.
          return stop();
        }
        if (!closed) timer = setTimeout(() => void check(), CHECK_MS);
      };
      request.signal.addEventListener('abort', stop, { once: true });
      send('retry: ' + RECONNECT_MS + '\nevent: ready\ndata: {}\n\n');
      timer = setTimeout(() => void check(), CHECK_MS);
    },
    cancel() {
      stopStream();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
