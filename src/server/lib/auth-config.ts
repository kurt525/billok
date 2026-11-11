/** SMTP settings exclusively for registration confirmation and account recovery.
 * Not an Auth.js sign-in provider: sending a message never authenticates anyone.
 */
import type { SMTPTransportOptions } from 'nodemailer';

/**
 * Registration confirmation is mandatory and must fail closed when its mail
 * transport or trusted public URL is not configured. Unlike optional Auth.js
 * Magic Link, this never falls back to a provider that can create users.
 */
export function readRegistrationEmailConfig(env: Record<string, string | undefined>): {
  siteOrigin: string;
  from: string;
  server: SMTPTransportOptions;
} {
  const invalid = () => new Error('Не настроена безопасная отправка подтверждения почты BillOK');
  const host = env.EMAIL_SERVER_HOST?.trim() ?? '';
  const rawPort = env.EMAIL_SERVER_PORT?.trim() || '587';
  const port = Number(rawPort);
  const username = env.EMAIL_SERVER_USER ?? '';
  const password = env.EMAIL_SERVER_PASSWORD ?? '';
  const from = env.EMAIL_FROM?.trim() || 'BillOK <noreply@billok.ru>';
  const siteOrigin = env.NEXTAUTH_URL?.trim() ?? '';

  // Never silently choose unencrypted SMTP, use partial credentials, or
  // substitute a different sender identity for noreply@billok.ru.
  if (
    !host ||
    host.length > 253 ||
    !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label) && label.length <= 63) ||
    !/^[0-9]+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !username.trim() ||
    !password.trim() ||
    (from !== 'BillOK <noreply@billok.ru>' && from !== 'noreply@billok.ru')
  ) {
    throw invalid();
  }

  let base: URL;
  try {
    base = new URL(siteOrigin);
  } catch {
    throw invalid();
  }

  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    !(base.protocol === 'https:' || (base.protocol === 'http:' && localHost)) ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  ) {
    throw invalid();
  }

  return {
    siteOrigin: base.origin,
    from,
    server: {
      host,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: username, pass: password },
    },
  };
}
