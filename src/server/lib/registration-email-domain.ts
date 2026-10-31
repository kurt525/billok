/**
 * BillOK registration policy: only DNS zones .ru and .su are eligible.
 * This is an additional check after full email syntax validation (Zod).
 * Match the final DNS label, not a substring such as "mail.ru.evil.com".
 */
export function isAllowedRegistrationEmailDomain(email: string): boolean {
  if (email !== email.trim()) return false;
  const separator = email.lastIndexOf('@');
  if (separator <= 0 || separator !== email.indexOf('@')) return false;

  const domain = email.slice(separator + 1).toLowerCase();
  if (domain.length > 253 || !/^[a-z0-9.-]+$/.test(domain)) return false;

  const labels = domain.split('.');
  if (labels.length < 2) return false;
  const zone = labels.pop();
  if (zone !== 'ru' && zone !== 'su') return false;

  return labels.every(
    (label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}
