import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { trustedApiMutation } from './api-request-security';

const expected = 'https://billok.ru';
const request = (path: string, method: string = 'POST', headers: Record<string, string> = {}, search: string = '') => ({
  method,
  pathname: path,
  search,
  headers: new Headers({
    host: 'billok.ru',
    origin: expected,
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    ...headers,
  }),
});

describe('Issue 6.12.6: same-origin CSRF and untrusted Host/Forwarded defense', () => {
  it('protects all mutation entrypoints in the actual middleware matcher', () => {
    const code = readFileSync('src/middleware.ts', 'utf8');
    expect(code).toContain("'/api/:path*'");
    expect(code).toContain('trustedApiMutation(');
    expect(code).toContain('readBillokWebAuthnRelyingParty(process.env)');
  });

  it('allows only trusted-origin API writes, not a same-site subdomain or null/foreign Origin', () => {
    for (const path of [
      '/api/trpc/auth.updateProfile',
      '/api/webauthn/owner/approval/start',
      '/api/webauthn/authentication/finish',
      '/api/admin/export',
    ]) {
      expect(trustedApiMutation(request(path), expected)).toBe(true);
      for (const origin of ['https://evil.ru', 'https://admin.billok.ru', 'null', 'http://billok.ru']) {
        expect(trustedApiMutation(request(path, 'POST', { origin }), expected)).toBe(false);
      }
      for (const metadata of ['cross-site', 'same-site']) {
        expect(trustedApiMutation(request(path, 'POST', { 'sec-fetch-site': metadata }), expected)).toBe(false);
      }
    }
  });

  it('never selects the trusted origin from attacker-controlled Host or forwarding headers', () => {
    for (const headers of [
      { host: 'evil.ru' },
      { 'x-forwarded-host': 'evil.ru' },
      { 'x-forwarded-host': 'billok.ru,evil.ru' },
      { forwarded: 'for=192.0.2.5;host=evil.ru;proto=https' },
      { forwarded: 'host=billok.ru;proto=http' },
      { forwarded: 'host=billok.ru,host=evil.ru' },
      { 'x-forwarded-proto': 'http' },
    ])
      expect(trustedApiMutation(request('/api/admin/export', 'POST', headers), expected)).toBe(false);
    expect(
      trustedApiMutation(
        request('/api/admin/export', 'POST', {
          forwarded: 'for=192.0.2.5;host=billok.ru;proto=https',
          'x-forwarded-host': 'billok.ru',
          'x-forwarded-proto': 'https',
        }),
        expected,
      ),
    ).toBe(true);
  });

  it('rejects CSRF HTML forms and oversized or ambiguous requests', () => {
    for (const contentType of ['text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded', '']) {
      expect(
        trustedApiMutation(
          request('/api/trpc/auth.updateProfile', 'POST', {
            origin: '',
            'sec-fetch-site': '',
            'content-type': contentType,
          }),
          expected,
        ),
      ).toBe(false);
    }
    expect(
      trustedApiMutation(
        request('/api/trpc/auth.updateProfile', 'POST', {
          origin: '',
          'sec-fetch-site': '',
          'content-type': 'application/json',
        }),
        expected,
      ),
    ).toBe(true); // API-client with non-simple content type
    expect(
      trustedApiMutation(
        request('/api/admin/export', 'POST', {
          'content-length': '65537',
        }),
        expected,
      ),
    ).toBe(false);
    expect(
      trustedApiMutation(
        request('/api/trpc/auth.updateProfile', 'POST', {
          'content-length': '2097153',
        }),
        expected,
      ),
    ).toBe(false);
    expect(
      trustedApiMutation(
        request('/api/trpc/auth.updateProfile', 'POST', {
          'content-length': '1e9',
        }),
        expected,
      ),
    ).toBe(false);
    expect(trustedApiMutation(request('/api/admin/export', 'POST', {}, '?approvalToken=secret'), expected)).toBe(false);
    expect(
      trustedApiMutation(request('/api/webauthn/owner/approval/start', 'POST', {}, '?token=secret'), expected),
    ).toBe(false);
  });

  it('leaves safe queries and Auth.js own CSRF middleware unchanged', () => {
    expect(
      trustedApiMutation(request('/api/trpc/auth.getSession', 'GET', { origin: 'https://evil.ru' }), expected),
    ).toBe(true);
    expect(
      trustedApiMutation(request('/api/auth/callback/passkey', 'POST', { origin: 'https://evil.ru' }), expected),
    ).toBe(true);
    expect(
      trustedApiMutation(request('/api/guest/token/events', 'POST', { origin: 'https://evil.ru' }), expected),
    ).toBe(true); // unrelated public event endpoint, not owner API
    expect(
      trustedApiMutation(
        request('/api/admin/impersonate', 'DELETE', {
          origin: '',
          'sec-fetch-site': '',
        }),
        expected,
      ),
    ).toBe(true); // non-browser client, DELETE is not a simple HTML form method
  });
});
