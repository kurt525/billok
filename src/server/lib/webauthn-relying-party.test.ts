import { describe, expect, it } from 'vitest';
import {
  WEBAUTHN_CHALLENGE_TTL_MS,
  WEBAUTHN_PASSKEY_POLICY,
  isDisposableWebAuthnQa,
  readBillokWebAuthnRelyingParty,
} from './webauthn-relying-party';

describe('Issue #1 6.3.1: WebAuthn configuration is pinned to trusted server settings', () => {
  it('defaults to the exact HTTPS billok.ru origin, requiring user verification', () => {
    expect(readBillokWebAuthnRelyingParty({ NODE_ENV: 'production' })).toEqual({
      rpId: 'billok.ru',
      origin: 'https://billok.ru',
      rpName: 'BillOK',
    });
    expect(WEBAUTHN_CHALLENGE_TTL_MS).toBe(300_000);
    expect(WEBAUTHN_PASSKEY_POLICY).toEqual({
      attestationType: 'none',
      residentKey: 'required',
      userVerification: 'required',
    });
  });

  it('allows explicit loopback http only during non-production development', () => {
    expect(
      readBillokWebAuthnRelyingParty({
        NODE_ENV: 'test',
        BILLOK_WEBAUTHN_ORIGIN: 'http://127.0.0.1:34001',
        BILLOK_WEBAUTHN_RP_ID: '127.0.0.1',
      }),
    ).toMatchObject({ origin: 'http://127.0.0.1:34001', rpId: '127.0.0.1' });
    expect(
      readBillokWebAuthnRelyingParty({
        NODE_ENV: 'development',
        BILLOK_WEBAUTHN_ORIGIN: 'http://localhost:3000',
        BILLOK_WEBAUTHN_RP_ID: 'localhost',
      }),
    ).toMatchObject({ origin: 'http://localhost:3000', rpId: 'localhost' });
  });

  it.each([
    { origin: 'http://billok.ru', rpId: 'billok.ru', mode: 'production' },
    { origin: 'http://billok.ru', rpId: 'billok.ru', mode: 'test' },
    { origin: 'http://127.0.0.1:3000', rpId: '127.0.0.1', mode: 'production' },
    { origin: 'https://evil.ru', rpId: 'billok.ru', mode: 'production' },
    { origin: 'https://billok.ru.evil.ru', rpId: 'billok.ru', mode: 'production' },
    { origin: 'https://billok.ru/path', rpId: 'billok.ru', mode: 'production' },
    { origin: 'https://billok.ru/', rpId: 'billok.ru', mode: 'production' },
    { origin: 'https://bob:secret@billok.ru', rpId: 'billok.ru', mode: 'production' },
    { origin: 'https://billok.ru?x=1', rpId: 'billok.ru', mode: 'production' },
    { origin: 'https://billok.ru#frag', rpId: 'billok.ru', mode: 'production' },
    { origin: 'https://billok.ru', rpId: '*.billok.ru', mode: 'production' },
    { origin: 'https://billok.ru', rpId: 'billok.ru.evil.ru', mode: 'production' },
    { origin: 'https://another.ru', rpId: 'another.ru', mode: 'production' },
    { origin: 'http://192.168.1.1:3000', rpId: '192.168.1.1', mode: 'test' },
  ])('rejects untrusted RP config: $origin / $rpId ($mode)', ({ origin, rpId, mode }) => {
    expect(() =>
      readBillokWebAuthnRelyingParty({
        NODE_ENV: mode,
        BILLOK_WEBAUTHN_ORIGIN: origin,
        BILLOK_WEBAUTHN_RP_ID: rpId,
      }),
    ).toThrow();
  });

  it('never enables QA loopback against a non-disposable database', () => {
    const qa = {
      NODE_ENV: 'production',
      BILLOK_QA_WEBAUTHN_LOOPBACK: '1',
      BILLOK_QA_FIXTURES: '1',
      BILLOK_WEBAUTHN_ORIGIN: 'http://localhost:32467',
      BILLOK_WEBAUTHN_RP_ID: 'localhost',
      DATABASE_URL: 'postgresql://qa:local@127.0.0.1:33279/billokqa',
    };
    expect(isDisposableWebAuthnQa(qa)).toBe(true);
    expect(readBillokWebAuthnRelyingParty(qa).rpId).toBe('localhost');
    for (const changed of [
      { BILLOK_QA_FIXTURES: '0' },
      { DATABASE_URL: 'postgresql://qa:local@db.example:5432/billokqa' },
      { DATABASE_URL: 'postgresql://qa:local@127.0.0.1:5432/billok' },
    ]) {
      const env = { ...qa, ...changed };
      expect(isDisposableWebAuthnQa(env)).toBe(false);
      expect(() => readBillokWebAuthnRelyingParty(env)).toThrow();
    }
  });

  it('does not consume untrusted request headers in origin decisions', () => {
    const result = readBillokWebAuthnRelyingParty({
      NODE_ENV: 'production',
      HOST: 'evil.ru',
      HTTP_HOST: 'evil.ru',
      HTTP_X_FORWARDED_HOST: 'evil.ru',
      HTTP_ORIGIN: 'https://evil.ru',
      NEXTAUTH_URL: 'https://evil.ru',
    });
    expect(result).toEqual({ rpId: 'billok.ru', origin: 'https://billok.ru', rpName: 'BillOK' });
  });
});
