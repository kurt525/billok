/**
 * Retired owner Passkey revocation entrypoint.
 *
 * Issue #1 6.12.4.6: the old two-step revoke path signed a challenge but
 * lacked the current Auth.js-session-bound, one-use owner approval grant.
 * Leave a fail-closed 410 marker for older clients instead of exposing a
 * parallel revocation mechanism. Use owner/approval/start+finish followed
 * by owner/manage/revoke.
 */
export async function POST() {
  return new Response('Этот способ отзыва Passkey больше не поддерживается.', {
    status: 410,
    headers: { 'Cache-Control': 'no-store' },
  });
}
