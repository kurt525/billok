import { createHash } from 'node:crypto';
import { normalizeAllowedRegistrationEmail } from './registration-email-domain';

/** Binds a one-time invitation proof to exactly the verified canonical address. */
export function registrationEmailProofHash(email: string): string | null {
  const normalized = normalizeAllowedRegistrationEmail(email);
  return normalized
    ? createHash('sha256')
        .update('billok-confirmed-registration-email:' + normalized, 'utf8')
        .digest('hex')
    : null;
}
