import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { isGuestLinkSecret, newGuestLinkSecret } from './guest-link-secret';

/** 3.25.2.3: authenticated encryption of personal links in PostgreSQL JSON.
 * HKDF purpose separation from shared link; 96-bit fresh AES-GCM nonce,
 * identity-bound AAD prevents ciphertext moving between guest person IDs.
 */
const VERSION = 'v1.';
const LABEL = 'billok:guest-person-link:v1';
const SALT = Buffer.from('billok:guest-person-links:v1');
const SEALED_PATTERN = /^v1\.[A-Za-z0-9_-]{95}$/;
type Person = { id?: string; personToken?: string; [field: string]: unknown };

function key(): Buffer {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32 || secret.startsWith('change-me')) {
    throw new Error('Не настроен ключ защиты персональных ссылок');
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), SALT, LABEL, 32));
}

function aad(id: string): Buffer {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error('Недопустимый идентификатор гостя');
  }
  return Buffer.from(LABEL + ':' + id, 'utf8');
}

export function issueGuestPersonToken(): string {
  return newGuestLinkSecret();
}

export function safeGuestPersonTokenEqual(actual: string | undefined, supplied: string): boolean {
  if (!actual || !isGuestLinkSecret(actual) || !isGuestLinkSecret(supplied)) return false;
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(supplied).digest();
  return timingSafeEqual(a, b);
}

export function sealGuestPersonToken(personId: string, bearer: string): string {
  if (!isGuestLinkSecret(bearer)) throw new Error('Недопустимый персональный токен');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  cipher.setAAD(aad(personId));
  const ciphertext = Buffer.concat([cipher.update(bearer, 'utf8'), cipher.final()]);
  return VERSION + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function revealGuestPersonToken(personId: string, sealed: string): string {
  try {
    if (!SEALED_PATTERN.test(sealed)) throw new Error('Недопустимый шифротекст');
    const packed = Buffer.from(sealed.slice(VERSION.length), 'base64url');
    if (packed.length !== 71 || packed.toString('base64url') !== sealed.slice(VERSION.length)) {
      throw new Error('Недопустимая кодировка');
    }
    const decipher = createDecipheriv('aes-256-gcm', key(), packed.subarray(0, 12));
    decipher.setAAD(aad(personId));
    decipher.setAuthTag(packed.subarray(12, 28));
    const bearer = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
    if (!isGuestLinkSecret(bearer)) throw new Error('Недопустимый исходный токен');
    return bearer;
  } catch {
    throw new Error('Персональная ссылка повреждена или недоступна');
  }
}

/** Query-boundary transformer; ciphertext is never returned to browser. */
export function sealGuestPeopleTokens(people: unknown): unknown {
  if (!Array.isArray(people)) return people;
  return people.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const person = entry as Person;
    if (!person.personToken) return entry;
    if (!person.id) throw new Error('Нет personId для персональной ссылки');
    if (!isGuestLinkSecret(person.personToken)) throw new Error('Недопустимый токен для сохранения в базе');
    return { ...person, personToken: sealGuestPersonToken(person.id, person.personToken) };
  });
}

export function revealGuestPeopleTokens(people: unknown): unknown {
  if (!Array.isArray(people)) return people;
  return people.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const person = entry as Person;
    if (!person.personToken) return entry;
    if (!person.id) throw new Error('Нет personId для персональной ссылки');
    return { ...person, personToken: revealGuestPersonToken(person.id, person.personToken) };
  });
}

export function revealGuestSplitResult<T>(result: T): T {
  if (Array.isArray(result)) return result.map((row) => revealGuestSplitResult(row)) as T;
  if (result && typeof result === 'object' && 'people' in result) {
    const record = result as Record<string, unknown>;
    return { ...record, people: revealGuestPeopleTokens(record.people) } as T;
  }
  return result;
}
