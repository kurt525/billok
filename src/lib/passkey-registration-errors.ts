/**
 * Only browser-facing WebAuthn registration errors belong in Issue #1 6.3.3.
 * Never render the untrusted DOMException text or leak server-side details.
 */
export type PasskeyRegistrationError = 'cancelled' | 'unsupported' | 'insecure' | 'existing' | 'failure';

type BrowserError = {
  name?: unknown;
  code?: unknown;
  cause?: { name?: unknown } | null;
};

export function classifyPasskeyRegistrationError(error: unknown): PasskeyRegistrationError {
  if (typeof error !== 'object' || error === null) return 'failure';
  const detail = error as BrowserError;
  const name = detail.name;
  const cause = detail.cause?.name;
  const code = detail.code;

  if (
    name === 'NotAllowedError' ||
    name === 'AbortError' ||
    cause === 'NotAllowedError' ||
    cause === 'AbortError' ||
    code === 'ERROR_CEREMONY_ABORTED'
  ) {
    return 'cancelled';
  }
  if (
    name === 'NotSupportedError' ||
    cause === 'NotSupportedError' ||
    code === 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT' ||
    code === 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT' ||
    code === 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG'
  ) {
    return 'unsupported';
  }
  if (
    name === 'SecurityError' ||
    cause === 'SecurityError' ||
    code === 'ERROR_INVALID_DOMAIN' ||
    code === 'ERROR_INVALID_RP_ID'
  ) {
    return 'insecure';
  }
  if (
    name === 'InvalidStateError' ||
    cause === 'InvalidStateError' ||
    code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
  ) {
    return 'existing';
  }
  return 'failure';
}

export const passkeyRegistrationMessages: Record<PasskeyRegistrationError, string> = {
  cancelled: 'Создание Passkey отменено или время ожидания истекло. Нажмите «Повторить создание Passkey».',
  unsupported:
    'Это устройство или браузер не поддерживает создание Passkey. Откройте письмо на устройстве с поддержкой ключей доступа.',
  insecure: 'Для создания Passkey требуется защищённое соединение и браузер с поддержкой WebAuthn.',
  existing: 'Этот ключ уже зарегистрирован. Попробуйте войти с Passkey или создать другой ключ доступа.',
  failure:
    'Не удалось завершить создание Passkey. Проверьте подключение и повторите попытку. Если ключ уже сохранён, попробуйте войти с ним.',
};
