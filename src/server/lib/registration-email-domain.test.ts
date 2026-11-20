import { describe, expect, it } from 'vitest';
import { isAllowedRegistrationEmailDomain, normalizeAllowedRegistrationEmail } from './registration-email-domain';

describe('BillOK registration allowed email domains', () => {
  it.each([
    'user@mail.ru',
    'user@example.su',
    'user@sub.company.ru',
    'user@deep.sub.company.su',
    'user@MAIL.RU',
    'user@Company.SU',
    'user@xn--d1acufc.ru',
    'user@xn--e1afmkfd.su',
    'User+News@SUB.Company.RU',
    'user@domain--ru.ru',
  ])('accepts email in the .ru or .su zone: %s', (email) => {
    expect(isAllowedRegistrationEmailDomain(email)).toBe(true);
  });

  it.each([
    'user@example.com',
    'user@example.net',
    'user@example.org',
    'user@example.рф',
    'user@mail.ru.com',
    'user@mail.su.evil.ru.com',
    'user@example-ru.com',
    'user@example-ru',
    'user@ru',
    'user@su',
    'user@.ru',
    'user@domain.ru.',
    'user@domain..ru',
    'user@-domain.ru',
    'user@domain-.ru',
    'user@domain_name.ru',
    'user@',
    'user@domain.ru@other.ru',
    '@domain.ru',
    ' user@domain.ru',
    'user@domain.ru ',
    'user@examplе.ru',
    'user@xn--xample-2of.ru',
    'user@xn--abc.ru',
    'user@xn--.ru',
    'user@xn--a.ru',
    'user@xn--p1ai',
    'user@ab--cd.ru',
    'user@domain.ru\r\nX-Injected: anything',
    'user@domain.ru\n',
    'user@domain.ru\t',
    'user @domain.ru',
    'usér@domain.ru',
    'user..name@domain.ru',
    '.user@domain.ru',
    'user.@domain.ru',
    'user@domain.ru@evil.ru',
    'user@domain.ru.',
    'user@domain.ru\u0000',
  ])('rejects addresses outside the allowed DNS zones or malformed domains: %s', (email) => {
    expect(isAllowedRegistrationEmailDomain(email)).toBe(false);
  });

  it('canonicalizes both local part and DNS labels without changing account identity', () => {
    expect(normalizeAllowedRegistrationEmail('USER+Alerts@Sub.Company.RU')).toBe('user+alerts@sub.company.ru');
    expect(normalizeAllowedRegistrationEmail('user+alerts@sub.company.ru')).toBe('user+alerts@sub.company.ru');
    expect(normalizeAllowedRegistrationEmail('USeR@xn--d1acufc.Ru')).toBe('user@xn--d1acufc.ru');
    expect(normalizeAllowedRegistrationEmail('user@xn--xample-2of.ru')).toBeNull();
    expect(normalizeAllowedRegistrationEmail('user@domain.ru.com')).toBeNull();
  });

  it('rejects whitespace, Unicode homoglyphs, bad IDN and double @ rather than repairing', () => {
    for (const email of [
      'user@domain.ru ',
      ' user@domain.ru',
      'user@domain.ru\r\n',
      'user@dоmain.ru',
      'user@xn--xample-2of.ru',
      'user@xn--abc.ru',
      'user@domain.ru@evil.ru',
      'user@domain..ru',
    ]) {
      expect(normalizeAllowedRegistrationEmail(email)).toBeNull();
    }
  });

  it('rejects an overlong DNS label and domain', () => {
    expect(isAllowedRegistrationEmailDomain('user@' + 'a'.repeat(64) + '.ru')).toBe(false);
    expect(isAllowedRegistrationEmailDomain('user@' + Array(6).fill('a'.repeat(50)).join('.') + '.ru')).toBe(false);
    expect(isAllowedRegistrationEmailDomain('user@a.ru')).toBe(true);
  });
});
