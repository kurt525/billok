import { describe, expect, it } from 'vitest';
import { isAllowedRegistrationEmailDomain } from './registration-email-domain';

describe('BillOK registration allowed email domains', () => {
  it.each([
    'user@mail.ru',
    'user@example.su',
    'user@sub.company.ru',
    'user@deep.sub.company.su',
    'user@MAIL.RU',
    'user@Company.SU',
    'user@xn--d1acufc.ru',
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
  ])('rejects addresses outside the allowed DNS zones or malformed domains: %s', (email) => {
    expect(isAllowedRegistrationEmailDomain(email)).toBe(false);
  });

  it('rejects an overlong DNS label and domain', () => {
    expect(isAllowedRegistrationEmailDomain('user@' + 'a'.repeat(64) + '.ru')).toBe(false);
    expect(isAllowedRegistrationEmailDomain('user@' + Array(6).fill('a'.repeat(50)).join('.') + '.ru')).toBe(false);
    expect(isAllowedRegistrationEmailDomain('user@a.ru')).toBe(true);
  });
});
