import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AppError } from '@/server/lib/app-error';
import { securityTargetFingerprint } from '@/server/lib/security-event-audit';

const { requireOwner } = vi.hoisted(() => ({ requireOwner: vi.fn() }));
vi.mock('@/server/lib/owner-access', () => ({ requireOwner }));
vi.mock('@/server/auth', () => ({ auth: vi.fn() }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('next/headers', () => ({ cookies: vi.fn().mockResolvedValue({ get: () => null }) }));

import { appRouter } from '../router';
import { adminRouter } from './admin';

function fixture(actorId: string) {
  const event = {
    id: 'e1',
    actorId: 'owner',
    action: 'admin.deleteUser',
    outcome: 'DENIED' as const,
    targetFingerprint: securityTargetFingerprint('target-1'),
    createdAt: new Date('2026-11-15T12:00:00Z'),
  };
  const db = {
    user: { findUnique: vi.fn().mockResolvedValue({ suspendedAt: null }) },
    securityEvent: {
      findMany: vi.fn().mockResolvedValue([event]),
      create: vi.fn().mockResolvedValue(event),
    },
    securityAlertDelivery: { create: vi.fn().mockResolvedValue({ bucket: 'claimed' }) },
    ownerBootstrap: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const caller = appRouter.createCaller({
    session: { user: { id: actorId, email: actorId + '@mail.ru' } },
    db,
    headers: new Headers({ cookie: 'authjs.session-token=verified-login' }),
    impersonating: null,
    locale: 'ru',
  } as unknown as Parameters<typeof appRouter.createCaller>[0]);
  return { caller, db, event };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOwner.mockResolvedValue(undefined);
});

describe('6.12.9: only sole owner can inspect security events, nobody can edit them', () => {
  test('normal registered user cannot read event journal', async () => {
    const { caller, db } = fixture('regular-user');
    requireOwner.mockRejectedValue(new AppError('FORBIDDEN'));
    await expect(caller.admin.getSecurityEvents({ limit: 20 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.securityEvent.findMany).not.toHaveBeenCalled();
  });

  test('owner gets sanitized subject, action, outcome, target fingerprint and timestamp', async () => {
    const { caller, db, event } = fixture('owner');
    expect(await caller.admin.getSecurityEvents({ limit: 20 })).toEqual({ items: [event], nextCursor: undefined });
    expect(requireOwner).toHaveBeenCalledWith(db, 'owner');
    expect(db.securityEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 21,
        select: {
          id: true,
          actorId: true,
          targetFingerprint: true,
          action: true,
          outcome: true,
          createdAt: true,
        },
      }),
    );
    const names = Object.keys(adminRouter._def.record);
    expect(names.filter((name) => /SecurityEvent/u.test(name))).toEqual(['getSecurityEvents']);
  });

  test('denied admin mutation is recorded even if requireOwner throws before DB transaction', async () => {
    const { caller, db } = fixture('non-owner');
    requireOwner.mockRejectedValue(new AppError('FORBIDDEN'));
    await expect(
      caller.admin.suspendUser({
        userId: 'target-1',
        approvalToken: 'b'.repeat(43),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.securityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'non-owner',
        action: 'admin.suspendUser',
        outcome: 'DENIED',
        targetFingerprint: securityTargetFingerprint('target-1'),
      }),
    });
  });

  test('allowed admin no-op records success but never exposes or mutates security table', async () => {
    const { caller, db } = fixture('owner');
    expect(await caller.admin.setVenmoEnabled({ enabled: false })).toEqual({ success: true });
    expect(db.securityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'owner',
        action: 'admin.setVenmoEnabled',
        outcome: 'ALLOWED',
        targetFingerprint: null,
      }),
    });
    expect(db.securityEvent).not.toHaveProperty('update');
    expect(db.securityEvent).not.toHaveProperty('delete');
  });
});
