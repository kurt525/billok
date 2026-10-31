import { createEmailVerificationToken } from './email-verification-token';

/** Form the link only from a trusted server-side NEXTAUTH_URL, never the request Host header. */
export function prepareRegistrationVerificationLink(configuredOrigin: string, now: Date = new Date()) {
  let base: URL;
  try {
    base = new URL(configuredOrigin);
  } catch {
    throw new Error('Не задан корректный адрес BillOK для подтверждения почты');
  }

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    !(base.protocol === 'https:' || (base.protocol === 'http:' && local)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  ) {
    throw new Error('Не задан корректный адрес BillOK для подтверждения почты');
  }

  const { token, tokenHash, expiresAt } = createEmailVerificationToken(now);
  const confirmation = new URL('/verify-email', base);
  confirmation.searchParams.set('token', token);
  return { url: confirmation.toString(), tokenHash, expiresAt };
}
