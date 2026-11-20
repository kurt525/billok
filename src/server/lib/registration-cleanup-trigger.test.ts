import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createRegistrationCleanupTrigger } from './registration-cleanup-trigger';

const db = {} as Pick<PrismaClient, 'systemInvite' | 'emailVerificationRequest'>;
const t0 = new Date('2026-10-31T10:00:00.000Z');

describe('registration cleanup trigger', () => {
  it('runs only once per hour per process and passes the same database and clock', async () => {
    const cleanup = vi.fn().mockResolvedValue({ releasedReservations: 1, deletedTokens: 2 });
    const trigger = createRegistrationCleanupTrigger(cleanup);
    await trigger(db, t0);
    await trigger(db, new Date(t0.getTime() + 59 * 60 * 1000));
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(db, t0);
    const later = new Date(t0.getTime() + 60 * 60 * 1000);
    await trigger(db, later);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenLastCalledWith(db, later);
  });

  it('shares one cleanup promise for concurrent registration attempts', async () => {
    let finish: ((value: { releasedReservations: number; deletedTokens: number }) => void) | undefined;
    const cleanup = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const trigger = createRegistrationCleanupTrigger(cleanup);
    const first = trigger(db, t0);
    const second = trigger(db, t0);
    expect(cleanup).toHaveBeenCalledOnce();
    if (!finish) throw new Error('Cleanup was not started');
    finish({ releasedReservations: 0, deletedTokens: 0 });
    await Promise.all([first, second]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not prevent registration on cleanup failure and backs off after a database error', async () => {
    const cleanup = vi.fn().mockRejectedValueOnce(new Error('Database offline'));
    const trigger = createRegistrationCleanupTrigger(cleanup);
    await expect(trigger(db, t0)).resolves.toBeUndefined();
    await expect(trigger(db, new Date(t0.getTime() + 10_000))).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
