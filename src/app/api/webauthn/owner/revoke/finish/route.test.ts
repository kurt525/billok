import { describe, expect, it } from 'vitest';
import { POST } from './route';

// Issue 6.12.4.6: old out-of-session management routes are deleted as live
// capabilities. Both a valid owner and unauthenticated caller get the same
// 410, regardless of JWT, forged action, target, nonce or WebAuthn response.
describe('6.12.4.6: retired legacy owner revoke finish API cannot bypass one-use proofs', () => {
  it('returns 410 without creating challenges, revoking keys or emitting a session', async () => {
    const response = await POST();
    expect(response.status).toBe(410);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('не поддерживается');
  });
});
