import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export type OwnerUserAction = 'USER_SUSPEND' | 'USER_UNSUSPEND' | 'USER_DELETE';

/**
 * Issue 6.12.4.2: the browser NEVER fabricates an administrative proof.
 * The server verifies a fresh owner WebAuthn assertion and returns a single-use
 * action+target+session-scoped token (TTL 120 seconds).
 */
export async function approveOwnerUserAction(action: OwnerUserAction, userId: string): Promise<string> {
  if (!userId || userId.length > 128 || !window.PublicKeyCredential) throw new Error('passkey-unavailable');
  const started = await fetch('/api/webauthn/owner/approval/start', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, targetId: userId }),
  });
  if (!started.ok) throw new Error('passkey-start-rejected');
  const data = (await started.json()) as { options?: PublicKeyCredentialRequestOptionsJSON };
  if (!data.options) throw new Error('passkey-missing-options');
  const signed = await startAuthentication({ optionsJSON: data.options });
  const finished = await fetch('/api/webauthn/owner/approval/finish', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
  });
  if (!finished.ok) throw new Error('passkey-verify-rejected');
  const result = (await finished.json()) as { approvalToken?: unknown };
  if (typeof result.approvalToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(result.approvalToken)) {
    throw new Error('passkey-proof-invalid');
  }
  return result.approvalToken;
}
