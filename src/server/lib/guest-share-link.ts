import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { hashGuestLinkSecret, isGuestLinkSecret, newGuestLinkSecret } from './guest-link-secret';

const ENCRYPTION_VERSION = 'v1';
const AAD = Buffer.from('billok:guest:share-link:v1', 'utf8');
// Impossible to store under the PostgreSQL 64-hex CHECK guard.
const MISSING_TOKEN_DIGEST = 'invalid-guest-share-token';

/**
 * 3.25.2.2: the creator can recover a valid shared link, but the database
 * stores only its SHA-256 lookup fingerprint and a sealed AES-256-GCM copy.
 * Derive a purpose-separated key from the deployed AUTH_SECRET. Never
 * persist the key or write its raw value to logs, JSON, or the Prisma model.
 *
 * AUTH_SECRET must remain stable for the lifetime of active links. A change
 * invalidates their encrypted copies: this project has no production links.
 */
function encryptionKey(): Buffer {
  const configured = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!configured || configured.length < 32 || configured.startsWith('change-me')) {
    throw new Error('Не настроен ключ защиты общих ссылок');
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(configured), Buffer.from('billok:guest-share-links:v1'), AAD, 32));
}

export type StoredGuestShareLink = {
  shareToken: string;
  shareTokenSealed: string | null;
};

/** Hash-based lookup; malformed and old cuid/UUID links cannot locate a row. */
export function shareLookupHash(token: string): string {
  return isGuestLinkSecret(token) ? hashGuestLinkSecret(token) : MISSING_TOKEN_DIGEST;
}

export function sealGuestShareToken(token: string): string {
  if (!isGuestLinkSecret(token)) throw new Error('Недопустимый формат общей ссылки');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENCRYPTION_VERSION + '.' + Buffer.concat([nonce, tag, ciphertext]).toString('base64url');
}

export function issueGuestShareLink(): { token: string; stored: StoredGuestShareLink } {
  const token = newGuestLinkSecret();
  return {
    token,
    stored: {
      shareToken: hashGuestLinkSecret(token),
      shareTokenSealed: sealGuestShareToken(token),
    },
  };
}

/** Call only AFTER verifying registered receipt creator's account ownership. */
export function revealGuestShareLink(stored: StoredGuestShareLink): string {
  const encoded = stored.shareTokenSealed;
  if (typeof encoded !== 'string' || !encoded.startsWith(ENCRYPTION_VERSION + '.') || encoded.length > 200) {
    throw new Error('Защищённая общая ссылка недоступна');
  }
  try {
    const body = Buffer.from(encoded.slice(ENCRYPTION_VERSION.length + 1), 'base64url');
    if (body.length !== 12 + 16 + 43 || body.toString('base64url') !== encoded.slice(3)) {
      throw new Error('Некорректная защищённая ссылка');
    }
    const nonce = body.subarray(0, 12);
    const tag = body.subarray(12, 28);
    const ciphertext = body.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (shareLookupHash(token) !== stored.shareToken) {
      throw new Error('Хеш общей ссылки не совпадает');
    }
    return token;
  } catch {
    // Do not leak secret, ciphertext or crypto errors to callers.
    throw new Error('Защищённая общая ссылка недоступна');
  }
}
