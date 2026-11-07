/**
 * Sign-in configuration parsed from environment variables.
 *
 * Parsing never throws: an invalid value falls back to its safe default and
 * adds a human-readable warning (logged when the auth module first loads),
 * so a typo in an optional auth setting can't take the whole app down.
 */

import type { SMTPTransportOptions } from 'nodemailer';
import { parseBooleanValue } from './env';

export type OidcTokenAuthMethod = 'client_secret_basic' | 'client_secret_post';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  displayName: string;
  autoRegister: boolean;
  allowEmailLinking: boolean;
  tokenAuthMethod: OidcTokenAuthMethod;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  passwordLogin: boolean;
  magicLink: boolean;
  oidc: OidcConfig | null;
  google: GoogleConfig | null;
  warnings: string[];
}

type Env = Record<string, string | undefined>;

const TOKEN_AUTH_METHODS: readonly OidcTokenAuthMethod[] = ['client_secret_basic', 'client_secret_post'];

function read(env: Env, name: string): string {
  return env[name]?.trim() ?? '';
}

function parseBoolean(env: Env, name: string, fallback: boolean, warnings: string[]): boolean {
  const value = read(env, name);
  if (value === '') return fallback;
  const parsed = parseBooleanValue(value);
  if (parsed !== null) return parsed;
  warnings.push(`${name} must be true/false, 1/0, yes/no or on/off; using the default (${fallback}).`);
  return fallback;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function parseTokenAuthMethod(env: Env, warnings: string[]): OidcTokenAuthMethod {
  const value = read(env, 'OIDC_TOKEN_AUTH_METHOD').toLowerCase();
  if (value === '') return 'client_secret_basic';
  const method = TOKEN_AUTH_METHODS.find((m) => m === value);
  if (method) return method;
  warnings.push(`OIDC_TOKEN_AUTH_METHOD must be one of ${TOKEN_AUTH_METHODS.join(', ')}; using client_secret_basic.`);
  return 'client_secret_basic';
}

function parseOidc(env: Env, warnings: string[]): OidcConfig | null {
  const issuer = read(env, 'OIDC_ISSUER');
  const clientId = read(env, 'OIDC_CLIENT_ID');
  const clientSecret = read(env, 'OIDC_CLIENT_SECRET');

  const required = { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret };
  const missing = Object.entries(required)
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length === Object.keys(required).length) return null;
  if (missing.length > 0) {
    warnings.push(`OIDC sign-in is disabled: ${missing.join(', ')} not set.`);
    return null;
  }
  if (!isHttpUrl(issuer)) {
    warnings.push('OIDC sign-in is disabled: OIDC_ISSUER must be an http(s) URL.');
    return null;
  }

  return {
    // Kept exactly as given: discovery requires it to equal (as a URL) the
    // `issuer` the IdP publishes, and whether a path ends in a slash matters
    // (Authentik's does).
    issuer,
    clientId,
    clientSecret,
    displayName: read(env, 'OIDC_DISPLAY_NAME') || 'SSO',
    autoRegister: parseBoolean(env, 'OIDC_AUTO_REGISTER', true, warnings),
    allowEmailLinking: parseBoolean(env, 'OIDC_ALLOW_EMAIL_LINKING', false, warnings),
    tokenAuthMethod: parseTokenAuthMethod(env, warnings),
  };
}

function parseGoogle(env: Env, warnings: string[]): GoogleConfig | null {
  const clientId = read(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = read(env, 'GOOGLE_CLIENT_SECRET');
  if (clientId === '' && clientSecret === '') return null;
  if (clientId === '' || clientSecret === '') {
    warnings.push(
      `Google sign-in is disabled: ${clientId === '' ? 'GOOGLE_CLIENT_ID' : 'GOOGLE_CLIENT_SECRET'} not set.`,
    );
    return null;
  }
  return { clientId, clientSecret };
}

export function parseAuthConfig(env: Env): AuthConfig {
  const warnings: string[] = [];
  const oidc = parseOidc(env, warnings);
  const google = parseGoogle(env, warnings);
  const magicLink = read(env, 'EMAIL_SERVER_HOST') !== '';

  let passwordLogin = !parseBoolean(env, 'DISABLE_PASSWORD_LOGIN', false, warnings);
  // Refuse to disable password login when no other sign-in method is
  // configured. (Whether existing accounts can use it is up to the admin; see
  // README.) Google doesn't count: unlike OIDC (email linking) or magic link
  // (any account, by its email), there's no way to move an existing account
  // to Google, so every password account, usually the admin's included, would
  // be locked out.
  if (!passwordLogin && !oidc && !magicLink) {
    warnings.push(
      'DISABLE_PASSWORD_LOGIN is ignored: neither OIDC nor magic link sign-in is configured (Google sign-in never links to an existing account).',
    );
    passwordLogin = true;
  }

  return { passwordLogin, magicLink, oidc, google, warnings };
}

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
