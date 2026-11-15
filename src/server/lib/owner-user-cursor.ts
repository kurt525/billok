import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from './app-error';

// Admin-only cursor: AES-256-GCM hides the real User.id, authenticates owner,
// query filters, page size and expiration. It is never a login capability.
// A process-local fallback key is used only when the Auth.js deployment
// secret is not configured (e.g. isolated unit tests); these cursors cannot
// survive a restart in that development configuration.
const processFallbackKey = randomBytes(32);
const CURSOR_TTL_MS = 60 * 60 * 1000;
const CURSOR_VERSION = 'u1';

function key(): Buffer {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  return secret
    ? createHash('sha256').update('billok-admin-user-pagination:v1:').update(secret).digest()
    : processFallbackKey;
}

export function encodeOwnerUserCursor(userId: string, ownerId: string, scope: string): string {
  if (!userId || !ownerId || !scope) throw new AppError('BAD_REQUEST');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const json = JSON.stringify({ v: 1, userId, ownerId, scope, expiresAt: Date.now() + CURSOR_TTL_MS });
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return CURSOR_VERSION + '.' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function decodeOwnerUserCursor(cursor: string, ownerId: string, scope: string): string {
  if (!cursor.startsWith(CURSOR_VERSION + '.') || cursor.length > 512) throw new AppError('BAD_REQUEST');
  try {
    const bytes = Buffer.from(cursor.slice(CURSOR_VERSION.length + 1), 'base64url');
    if (bytes.length < 29) throw new Error('bad length');
    const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const value: unknown = JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
    );
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('v' in value) ||
      value.v !== 1 ||
      !('ownerId' in value) ||
      value.ownerId !== ownerId ||
      !('scope' in value) ||
      value.scope !== scope ||
      !('userId' in value) ||
      typeof value.userId !== 'string' ||
      !value.userId ||
      !('expiresAt' in value) ||
      typeof value.expiresAt !== 'number' ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + CURSOR_TTL_MS
    )
      throw new Error('wrong owner, query, or expired');
    return value.userId;
  } catch {
    throw new AppError('BAD_REQUEST');
  }
}

export function ownerUserCursorScope(kind: string, filters: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, filters]))
    .digest('base64url')
    .slice(0, 28);
}
