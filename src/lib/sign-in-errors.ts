/** Only local login errors. External identity providers are removed. */
export type SignInErrorKey = 'sessionActive' | 'pendingEmailConfirmation' | 'generic';

const ERRORS = new Map<string, SignInErrorKey>([
  ['SessionActive', 'sessionActive'],
  ['RegistrationEmailUnverified', 'pendingEmailConfirmation'],
]);

export function getSignInErrorKey(code: string | null): SignInErrorKey | null {
  if (!code) return null;
  return ERRORS.get(code) ?? 'generic';
}
