import { describe, expect, it } from 'vitest';
import { registrationEmailProofHash } from './registration-email-proof';

describe('6.14.5: exact address-bound registration email proof', () => {
  it('canonicalizes case while preserving distinct mailbox identities', () => {
    expect(registrationEmailProofHash('User@MAIL.RU')).toBe(registrationEmailProofHash('user@mail.ru'));
    expect(registrationEmailProofHash('user@mail.ru')).not.toBe(registrationEmailProofHash('user@mail.su'));
    expect(registrationEmailProofHash('user@mail.ru')).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['user@example.com', 'user@mail.ru.evil.com', 'user@mail.ru\\n', 'user@other.рф'])(
    'refuses to bind forbidden or malformed address: %s',
    (email) => expect(registrationEmailProofHash(email)).toBeNull(),
  );
});
