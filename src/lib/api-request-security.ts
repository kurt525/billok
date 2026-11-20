/**
 * Issue 6.12.6: fail-closed CSRF/host policy for cookie-authenticated API
 * mutations. The trusted public origin is configured by the SERVER and
 * cannot be learned from Host, Forwarded or X-Forwarded-* request headers.
 *
 * Browser writes provide Origin (or Fetch Metadata for some DELETE requests).
 * Native test/automation clients without these browser headers are accepted
 * only with JSON or a non-simple HTTP method; an HTML form cannot imitate a
 * cross-site application/json fetch without a browser CORS preflight.
 */
export function trustedApiMutation(
  request: {
    method: string;
    pathname: string;
    headers: Headers;
    search?: string;
  },
  trustedOrigin: string,
): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return true;
  if (!/^\/api\/(?:admin|webauthn|trpc)(?:\/|$)/u.test(request.pathname)) return true;
  // Auth.js already enforces its own anti-CSRF tokens for login/logout.
  if (request.pathname.startsWith('/api/auth/')) return true;

  const expected = new URL(trustedOrigin);
  const expectedHost = expected.host.toLowerCase();
  const host = request.headers.get('host');
  if (host && host.toLowerCase() !== expectedHost) return false;
  for (const name of ['x-forwarded-host', 'forwarded']) {
    const value = request.headers.get(name);
    if (!value) continue;
    if (name === 'forwarded') {
      // A proxy may supply Forwarded: host=<public-host>; proto=<scheme>.
      // Any ambiguity (multiple proxies / unknown tokens) fails closed.
      const pairs = value.split(';').map((part) => part.trim());
      if (value.includes(',')) return false;
      if (pairs.some((part) => !/^(?:host|proto|for|by)=/iu.test(part))) return false;
      for (const part of pairs) {
        const equal = part.indexOf('=');
        const key = part.slice(0, equal).toLowerCase();
        const field = part.slice(equal + 1).replace(/^"|"$/gu, '');
        if (key === 'host' && field.toLowerCase() !== expectedHost) return false;
        if (key === 'proto' && field !== expected.protocol.slice(0, -1)) return false;
      }
    } else if (value.toLowerCase() !== expectedHost) return false;
  }
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto && forwardedProto !== expected.protocol.slice(0, -1)) return false;

  // Tokens must never be passed to privileged mutation URLs.
  if (
    request.search &&
    (request.pathname.startsWith('/api/admin/') || request.pathname.startsWith('/api/webauthn/owner/'))
  )
    return false;

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== trustedOrigin) return false;
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  // Refuse cross-site HTML forms; no CORS headers or JSON preflight grants.
  if (
    !origin &&
    !fetchSite &&
    request.method === 'POST' &&
    contentType !== 'application/json' &&
    !contentType.endsWith('+json')
  )
    return false;

  const length = request.headers.get('content-length');
  if (length !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(length)) return false;
    const max = request.pathname.startsWith('/api/trpc/') ? 2_097_152 : 65_536;
    if (!Number.isSafeInteger(Number(length)) || Number(length) > max) return false;
  }
  return true;
}
