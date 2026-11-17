import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import createIntlMiddleware from 'next-intl/middleware';
import { routing } from '@/i18n/routing';
import { trustedApiMutation } from '@/lib/api-request-security';
import { readBillokWebAuthnRelyingParty } from '@/server/lib/webauthn-relying-party';
import { stripLocalePrefix } from '@/lib/locale-paths';

const intlMiddleware = createIntlMiddleware(routing);
const publicPages = ['/login', '/register', '/verify-email', '/setup-owner', '/recover-passkey', '/invite', '/split'];

function isPublicPage(pathname: string): boolean {
  return publicPages.some((page) => pathname === page || pathname.startsWith(page + '/'));
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  // Apply the same configured-origin check to tRPC and every WebAuthn/admin
  // mutation before routing. Never use Host/Forwarded to choose the origin.
  if (pathname.startsWith('/api/')) {
    if (!pathname.startsWith('/api/auth/')) {
      try {
        const rp = readBillokWebAuthnRelyingParty(process.env);
        if (
          !trustedApiMutation(
            {
              method: request.method,
              pathname,
              headers: request.headers,
              search: request.nextUrl.search,
            },
            rp.origin,
          )
        ) {
          return new NextResponse('Недоверенный источник запроса', {
            status: 403,
            headers: { 'Cache-Control': 'no-store' },
          });
        }
      } catch {
        return new NextResponse('Ошибка настроек безопасности', { status: 403 });
      }
    }
    const response = NextResponse.next();
    if (/^\/api\/(?:admin|webauthn)/u.test(pathname)) {
      response.headers.set('Cache-Control', 'no-store');
    }
    return response;
  }

  // Next-intl internally rewrites /login to /ru/login. That internal request
  // passes through middleware again: redirecting it to /login creates a 308 loop.
  // Let /ru paths render, while still applying the same authentication checks.
  const internalRussianPath = pathname === '/ru' || pathname.startsWith('/ru/');
  const canonicalPath = internalRussianPath ? stripLocalePrefix(pathname) : pathname;

  const intlResponse = internalRussianPath ? NextResponse.next() : intlMiddleware(request);
  const callbackUrl = `${canonicalPath}${request.nextUrl.search}`;
  const isSecure = request.nextUrl.protocol === 'https:';
  const cookieName = isSecure ? '__Secure-authjs.session-token' : 'authjs.session-token';

  let token;
  try {
    token = await getToken({
      req: request,
      cookieName,
      ...(process.env.AUTH_SECRET !== undefined ? { secret: process.env.AUTH_SECRET } : {}),
    });
  } catch {
    // Malformed or forged JWT — treat as unauthenticated.
  }

  if (isPublicPage(canonicalPath) || canonicalPath === '/') return intlResponse;

  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', callbackUrl);
    return NextResponse.redirect(loginUrl);
  }

  return intlResponse;
}

export const config = {
  matcher: ['/api/:path*', '/((?!api|_next|_vercel|favicon\\.png|icon\\.svg|icons|manifest\\.json|.*\\..*).*)'],
};
