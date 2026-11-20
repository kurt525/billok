import type { PrismaClient } from '@/generated/prisma/client';
import { logger } from './logger';
import { cleanupExpiredRegistrationRequests } from './registration-cleanup';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Best-effort lazy cleanup on eligible registration attempts.
 * At most one cleanup per process per hour, with concurrent calls sharing
 * one promise; a database failure must not prevent account registration.
 * There is intentionally no periodic timer or automatic production deploy.
 */
export function createRegistrationCleanupTrigger(
  cleanup: typeof cleanupExpiredRegistrationRequests = cleanupExpiredRegistrationRequests,
) {
  let nextAllowedAt = 0;
  let pending: Promise<void> | null = null;

  return async (
    db: Pick<PrismaClient, 'systemInvite' | 'emailVerificationRequest'>,
    now: Date = new Date(),
  ): Promise<void> => {
    if (pending) return pending;
    if (now.getTime() < nextAllowedAt) return;

    nextAllowedAt = now.getTime() + CLEANUP_INTERVAL_MS;
    const task = (async () => {
      try {
        await cleanup(db, now);
      } catch {
        // The attempt is throttled even on failure: avoid making registration
        // requests a database write-amplification vector during an outage.
        logger.warn('auth.registration_cleanup_failed');
      }
    })();
    pending = task;
    try {
      await task;
    } finally {
      pending = null;
    }
  };
}

export const runRegistrationCleanupIfDue = createRegistrationCleanupTrigger();
