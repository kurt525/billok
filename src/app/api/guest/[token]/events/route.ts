import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { shareLookupHash } from '@/server/lib/guest-share-link';
import { revealGuestPeopleTokens } from '@/server/lib/guest-person-secret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// EventSource cannot carry a guest bearer token in a custom header. A POST
// verifies the guest credential (or the signed-in receipt creator) and
// returns a short-lived, receipt-scoped HttpOnly cookie. Never place the
// guest secret in the URL, an SSE event, or a readable browser cookie.
const COOKIE = 'billok_receipt_events';
const TICKET_MS = 5 * 60_000;
const CHECK_MS = 1500;
const HEARTBEAT_EVERY = 8;
const RECONNECT_MS = 2000;
const MAX_SPLIT_STREAMS = 32;
const MAX_TOTAL_STREAMS = 256;
const streamsPerToken = new Map<string, number>();
let allStreams = 0;

type Person = { id?: string; personToken?: string };
type Snapshot = {
  version: string;
  expiresAt: Date;
  userId: string | null;
  people: Person[];
};
type Ticket = {
  token: string;
  expires: number;
  ownerId?: string;
  personId?: string;
  secretHash?: string;
};

function ticketKey(): string | null {
  // Auth.js uses this same deployment secret, managed outside source control.
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? null;
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function mintTicket(ticket: Ticket, key: string): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return payload + '.' + signature;
}

function validTicket(request: Request, token: string): Ticket | null {
  const key = ticketKey();
  const raw = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE + '='))
    ?.slice(COOKIE.length + 1);
  if (!key || !raw || raw.length > 2000) return null;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', key).update(payload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Ticket;
    if (
      ticket.token !== token ||
      !Number.isSafeInteger(ticket.expires) ||
      ticket.expires <= Date.now() ||
      ticket.expires > Date.now() + TICKET_MS
    ) {
      return null;
    }
    if (ticket.ownerId && !ticket.personId && !ticket.secretHash) return ticket;
    if (ticket.personId && ticket.secretHash && !ticket.ownerId) return ticket;
  } catch {
    // Malformed/tampered cookie: do not disclose whether the receipt exists.
  }
  return null;
}

function authorized(snapshot: Snapshot, ticket: Ticket): boolean {
  if (ticket.expires <= Date.now() || snapshot.expiresAt <= new Date()) return false;
  if (ticket.ownerId) return snapshot.userId === ticket.ownerId;
  const person = snapshot.people.find((p) => p.id === ticket.personId);
  return !!person?.personToken && hashSecret(person.personToken) === ticket.secretHash;
}

// xmin changes for every committed PostgreSQL row update, including those
// within one millisecond. Only send invalidations, never personal details.
async function sessionRevision(token: string): Promise<Snapshot | null> {
  const rows = await db.$queryRawUnsafe<Snapshot[]>(
    'SELECT xmin::text AS "version", "expiresAt", "userId", "people" FROM "GuestSplit" WHERE "shareToken" = $1 LIMIT 1',
    shareLookupHash(token),
  );
  const row = rows[0];
  if (!row || !Array.isArray(row.people)) return null;
  // Raw SQL is needed for xmin but bypasses Prisma's GuestSplit decryption.
  // Reject damaged/swapped ciphertext without leaking personal credentials.
  try {
    return { ...row, people: revealGuestPeopleTokens(row.people) as Person[] };
  } catch {
    return null;
  }
}

function validShareToken(token: string): boolean {
  return !!token && token.length <= 64;
}

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

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!validShareToken(token)) return new Response(null, { status: 404 });
  const key = ticketKey();
  if (!key) return new Response(null, { status: 503 });
  // Avoid accepting any cross-origin credential issuance, including browser
  // requests carrying an already signed-in creator's session cookie.
  const origin = request.headers.get('origin');
  const directOrigin = new URL(request.url).origin;
  // In production Next.js may receive HTTP from our trusted TLS-terminating
  // reverse proxy while the browser uses HTTPS on billok.ru.
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const publicOrigin =
    forwardedHost && (forwardedProto === 'https' || forwardedProto === 'http')
      ? forwardedProto + '://' + forwardedHost
      : directOrigin;
  if (origin && origin !== directOrigin && origin !== publicOrigin) return new Response(null, { status: 403 });
  let personId: string | undefined;
  let personToken: string | undefined;
  try {
    const data = (await request.json()) as { personId?: unknown; personToken?: unknown };
    if (typeof data.personId === 'string' && typeof data.personToken === 'string') {
      if (data.personId.length > 64 || data.personToken.length > 64) return new Response(null, { status: 404 });
      personId = data.personId;
      personToken = data.personToken;
    }
  } catch {
    return new Response(null, { status: 400 });
  }

  const current = await sessionRevision(token);
  if (!current || current.expiresAt <= new Date()) return new Response(null, { status: 404 });
  let ticket: Ticket | null = null;
  if (personId && personToken && current.people.some((p) => p.id === personId && p.personToken === personToken)) {
    ticket = { token, personId, secretHash: hashSecret(personToken), expires: Date.now() + TICKET_MS };
  } else {
    const loggedIn = await auth();
    if (loggedIn?.user?.id && current.userId === loggedIn.user.id) {
      ticket = { token, ownerId: loggedIn.user.id, expires: Date.now() + TICKET_MS };
    }
  }
  // Do not distinguish a real, unrelated receipt from a made-up receipt.
  if (!ticket) return new Response(null, { status: 404 });
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(COOKIE, mintTicket(ticket, key), {
    httpOnly: true,
    sameSite: 'strict',
    secure: request.url.startsWith('https:') || forwardedProto === 'https',
    path: '/api/guest/' + encodeURIComponent(token) + '/events',
    maxAge: TICKET_MS / 1000,
  });
  return response;
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!validShareToken(token)) return new Response(null, { status: 404 });
  const ticket = validTicket(request, token);
  if (!ticket) return new Response(null, { status: 404 });
  const initial = await sessionRevision(token);
  if (!initial || !authorized(initial, ticket)) return new Response(null, { status: 404 });
  // An owner ticket is valid only while their Auth.js session still exists.
  if (ticket.ownerId && (await auth())?.user?.id !== ticket.ownerId) {
    return new Response(null, { status: 404 });
  }
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
          // The browser already canceled the response.
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
          // A removed guest, a rotated personal link, an expired ticket or
          // deleted receipt must immediately stop receiving even change hints.
          if (!current || !authorized(current, ticket)) return stop();
          // The owner's login is a live authorization, not a permanent
          // bearer grant. Recheck before sending changes and on keepalive.
          // Guest credentials are revalidated against the database on EVERY
          // tick, including personal-link rotation and participant removal.
          if (
            ticket.ownerId &&
            (current.version !== revision || (ticks + 1) % HEARTBEAT_EVERY === 0) &&
            (await auth())?.user?.id !== ticket.ownerId
          ) {
            return stop();
          }
          if (current.version !== revision) {
            revision = current.version;
            send('event: changed\ndata: {}\n\n');
          } else if (++ticks % HEARTBEAT_EVERY === 0) {
            send(': keepalive\n\n');
          }
        } catch {
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
