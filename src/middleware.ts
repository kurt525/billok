import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import createIntlMiddleware from 'next-intl/middleware';
import { routing } from '@/i18n/routing';
import { hasLocalePrefix, stripLocalePrefix } from '@/lib/locale-paths';

const intlMiddleware = createIntlMiddleware(routing);
const publicPages = ['/login', '/register', '/verify-request', '/invite', '/split'];

function isPublicPage(pathname: string): boolean {
  return publicPages.some((page) => pathname === page || pathname.startsWith(page + '/'));
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Old /en/split/... guest links stay usable; redirect BEFORE the auth check,
  // then let the canonical path apply its normal authentication rules.
  if (hasLocalePrefix(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = stripLocalePrefix(pathname);
    return NextResponse.redirect(url, 308);
  }

  const intlResponse = intlMiddleware(request);
  const callbackUrl = `${pathname}${request.nextUrl.search}`;
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

  if (isPublicPage(pathname) || pathname === '/') return intlResponse;

  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('callbackUrl', callbackUrl);
    return NextResponse.redirect(loginUrl);
  }

  return intlResponse;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|favicon\\.png|icon\\.svg|icons|manifest\\.json|.*\\..*).*)'],
};
