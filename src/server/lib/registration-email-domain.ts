import { domainToASCII, domainToUnicode } from 'node:url';

// Issue #1 6.14.1: one canonical, case-insensitive account address. The
// database-level constraint and all remaining auth entrypoints are addressed
// separately by 6.14.2 and 6.14.3.
const LOCAL_ATOM = /^[a-z0-9!#$%&'*+/=?^_\x60{|}~.-]+$/iu;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const ASCII_PRINTABLE = /^[\x21-\x7e]+$/u;
const LATIN_IDN = /^[\p{Script=Latin}0-9-]+$/u;
const CYRILLIC_IDN = /^[\p{Script=Cyrillic}0-9-]+$/u;

/** Returns the canonical address or null. Never silently fix malformed input.
 * BillOK treats the entire local part as case-insensitive, matching existing
 * findUsersByEmail(lower(email) = lower(input)) lookups. Unicode U-labels,
 * mixed-script confusables and invalid IDNA A-labels are not accepted.
 */
export function normalizeAllowedRegistrationEmail(email: string): string | null {
  if (email.length > 254 || !ASCII_PRINTABLE.test(email)) return null;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return null;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (
    local.length > 64 ||
    !LOCAL_ATOM.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    domain.length < 4 ||
    domain.length > 253
  )
    return null;

  const labels = domain.split('.');
  if (labels.length < 2) return null;
  const zone = labels.pop();
  if (zone !== 'ru' && zone !== 'su') return null;

  for (const label of labels) {
    if (label.length < 1 || label.length > 63 || !DOMAIN_LABEL.test(label)) return null;
    // Hyphens at positions 3 and 4 are reserved for the xn-- IDN prefix.
    if (label[2] === '-' && label[3] === '-' && !label.startsWith('xn--')) return null;
    if (label.startsWith('xn--')) {
      const decoded = domainToUnicode(label);
      if (
        !decoded ||
        decoded === label ||
        domainToASCII(decoded) !== label ||
        !(LATIN_IDN.test(decoded) || CYRILLIC_IDN.test(decoded))
      )
        return null;
    }
  }
  return local.toLowerCase() + '@' + domain;
}

/** Backwards-compatible public predicate for bootstrap, recovery and signup. */
export function isAllowedRegistrationEmailDomain(email: unknown): email is string {
  return typeof email === 'string' && normalizeAllowedRegistrationEmail(email) !== null;
}
