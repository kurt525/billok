import { describe, expect, it } from 'vitest';
import { classifyPasskeyRegistrationError, passkeyRegistrationMessages } from './passkey-registration-errors';

describe('Issue #1 6.3.3: mobile Passkey enrollment error feedback', () => {
  it.each([
    [{ name: 'NotAllowedError' }, 'cancelled'],
    [{ name: 'AbortError' }, 'cancelled'],
    [{ code: 'ERROR_CEREMONY_ABORTED' }, 'cancelled'],
    [{ code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', cause: { name: 'NotAllowedError' } }, 'cancelled'],
    [{ name: 'NotSupportedError' }, 'unsupported'],
    [{ code: 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT' }, 'unsupported'],
    [{ code: 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT' }, 'unsupported'],
    [{ code: 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG' }, 'unsupported'],
    [{ name: 'SecurityError' }, 'insecure'],
    [{ code: 'ERROR_INVALID_RP_ID' }, 'insecure'],
    [{ name: 'InvalidStateError' }, 'existing'],
    [{ code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' }, 'existing'],
    [new Error('some internal detail'), 'failure'],
    [null, 'failure'],
  ] as const)('maps browser failure %j to %s without disclosing exception text', (error, status) => {
    expect(classifyPasskeyRegistrationError(error)).toBe(status);
    expect(passkeyRegistrationMessages[status]).not.toContain('internal detail');
  });
  it('keeps every message Russian and gives users an actionable next step', () => {
    for (const value of Object.values(passkeyRegistrationMessages)) {
      expect(value).toMatch(/[А-Яа-яЁё]/);
      expect(value.length).toBeGreaterThan(45);
    }
  });
});
