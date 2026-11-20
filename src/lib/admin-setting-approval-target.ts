/** Issue 6.12.4.4: cryptographic scope for a precise administrative value.
 * Both routes and browser compute the same value; no arbitrary client target
 * is ever trusted by the mutation.
 */
export type RegistrationSettingMode = 'open' | 'invite-only' | 'closed';

export function registrationModeApprovalTarget(mode: RegistrationSettingMode): string {
  return 'registration-mode:v1:' + mode;
}

export async function announcementApprovalTarget(message?: string): Promise<string> {
  const canonical = message?.trim() ?? '';
  // Exact public announcement content may be up to 500 chars; the WebAuthn
  // challenge's fixed <=128 char object ID carries its SHA-256 fingerprint.
  const data = new TextEncoder().encode('billok:admin-announcement:v1:' + canonical);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return 'announcement:v1:' + hex;
}
