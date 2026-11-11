import { describe, expect, test } from 'vitest';
import { getSignInErrorKey } from './sign-in-errors';

describe('sign-in errors without external identity providers', () => {
  test('missing code is not an error', () => {
    expect(getSignInErrorKey(null)).toBeNull();
    expect(getSignInErrorKey('')).toBeNull();
  });
  test('only local statuses use explicit UI messages', () => {
    expect(getSignInErrorKey('SessionActive')).toBe('sessionActive');
    expect(getSignInErrorKey('RegistrationEmailUnverified')).toBe('pendingEmailConfirmation');
  });
  test.each([
    'GoogleSessionActive',
    'OidcAccountNotLinked',
    'Verification',
    'OAuthAccountNotLinked',
    'AccessDenied',
    'constructor',
    '__proto__',
  ])('does not map removed provider error %s', (code) => {
    expect(getSignInErrorKey(code)).toBe('generic');
  });
});
