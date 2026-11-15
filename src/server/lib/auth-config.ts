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
    username !== username.trim() ||
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
  // The ONLY alternate SMTP is an ephemeral loopback mailbox in the disposable
  // mobile CI database. The flag alone is never enough to permit an SMTP relay.
  const qaDbUrl = env.DATABASE_URL ?? '';
  const isolatedQa =
    env.BILLOK_QA_FIXTURES === '1' &&
    env.BILLOK_QA_WEBAUTHN_LOOPBACK === '1' &&
    /^postgresql?:\/\/billokqa:billokqa_local_only@127\.0\.0\.1:\d+\/billokqa$/u.test(qaDbUrl) &&
    localHost &&
    host === '127.0.0.1' &&
    port >= 1024 &&
    env.BILLOK_QA_SMTP_PORT === rawPort &&
    username === 'billok-qa' &&
    password === 'qa-local-only' &&
    from === 'noreply@billok.ru';

  // Issue #1 7.1: production mail is REG.RU only, with a fixed authenticated
  // noreply mailbox. Mailbox credentials come exclusively from runtime env.
  // The official REG.RU mail-hosting SMTP endpoint supports 465/SSL or
  // 587/STARTTLS; no insecure transport, custom server or fallback provider.
  const regRuSmtp =
    host === 'mail.hosting.reg.ru' && (port === 465 || port === 587) && username === 'noreply@billok.ru';
  if (!regRuSmtp && !isolatedQa) throw invalid();
  if (isolatedQa && (base.protocol !== 'http:' || !localHost)) throw invalid();
  if (regRuSmtp && base.protocol !== 'https:') throw invalid();

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
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      auth: { user: username, pass: password },
    },
  };
}
