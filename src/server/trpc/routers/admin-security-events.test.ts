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

function fixture(actorId: string | null, impersonating: unknown = null) {
  const event = {
    id: 'e1',
    actorId: 'owner',
    action: 'admin.deleteUser',
    outcome: 'DENIED' as const,
    targetFingerprint: securityTargetFingerprint('target-1'),
    createdAt: new Date('2026-11-15T12:00:00Z'),
  };
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ suspendedAt: null, email: 'owner@mail.ru' }),
      findMany: vi.fn().mockResolvedValue([{ id: 'owner', name: 'Владелец', email: 'owner@mail.ru' }]),
    },
    securityEvent: {
      findMany: vi.fn().mockResolvedValue([event]),
      create: vi.fn().mockResolvedValue(event),
    },
    securityAlertDelivery: { create: vi.fn().mockResolvedValue({ bucket: 'claimed' }) },
    ownerBootstrap: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const caller = appRouter.createCaller({
    session: actorId ? { user: { id: actorId, email: actorId + '@mail.ru' } } : null,
    db,
    headers: new Headers({ cookie: 'authjs.session-token=verified-login' }),
    impersonating,
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
    expect(await caller.admin.getSecurityEvents({ limit: 20 })).toEqual({
      items: [{ ...event, actor: { name: 'Владелец', email: 'owner@mail.ru', isOwner: true } }],
      nextCursor: undefined,
    });
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
});

describe('TASK-BILLOK-011 — filtered security history', () => {
  const a = 'abcdef12-1234-4abc-8def-123456789abc';
  const b = 'abcdef12-4321-4abc-8def-123456789abc';
  const missing = '01234567-4321-4abc-8def-123456789abc';

  test('normalizes full UUID and scopes cursor to filter; 43 rows in three pages', async () => {
    const { caller, db, event } = fixture('owner');
    const rows = Array.from({ length: 43 }, (_, i) => ({
      ...event,
      id: 'evt-' + String(i).padStart(3, '0'),
      actorId: i % 2 ? a.toUpperCase() : a,
    })).reverse();
    const others = Array.from({ length: 25 }, (_, i) => ({
      ...event,
      id: 'other-' + i,
      actorId: b,
      createdAt: new Date('2026-11-29T00:00:00.000Z'),
    }));
    const all = [...others, ...rows];
    db.securityEvent.findMany.mockImplementation(async (args) => {
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      const matching = args.where ? all.filter((row) => row.actorId.toLowerCase() === args.where.actorId.equals) : all;
      const start = args.cursor ? matching.findIndex((row) => row.id === args.cursor.id) + args.skip : 0;
      return matching.slice(start, start + args.take);
    });
    db.user.findMany.mockResolvedValue([{ id: a, name: 'Гость', email: 'one@mail.ru' }]);
    const first = await caller.admin.getSecurityEvents({
      actorId: ' ' + a.toUpperCase() + ' ',
      limit: 20,
      direction: 'forward',
    });
    expect(first.items).toHaveLength(20);
    expect(first.items.every((row) => row.actor?.email === 'one@mail.ru')).toBe(true);
    expect(first.nextCursor).toMatch(/^u1\./u);
    expect(db.securityEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { actorId: { equals: a, mode: 'insensitive' } }, take: 21 }),
    );
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect(db.user.findMany).toHaveBeenLastCalledWith({
      where: { id: { in: expect.arrayContaining([a, a.toUpperCase()]) }, isPlaceholder: false },
      select: { id: true, name: true, email: true },
    });
    await expect(
      caller.admin.getSecurityEvents({ actorId: b, cursor: first.nextCursor!, limit: 20 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.admin.getSecurityEvents({ cursor: first.nextCursor!, limit: 20 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    all.unshift({ ...event, id: 'fresh', actorId: a, createdAt: new Date('2026-11-30T00:00:00.000Z') });
    const second = await caller.admin.getSecurityEvents({ actorId: a, cursor: first.nextCursor!, limit: 20 });
    const third = await caller.admin.getSecurityEvents({ actorId: a, cursor: second.nextCursor!, limit: 20 });
    expect(third.nextCursor).toBeUndefined();
    expect([...first.items, ...second.items, ...third.items].map((x) => x.id)).toEqual(rows.map((x) => x.id));
    expect(new Set([...first.items, ...second.items, ...third.items].map((x) => x.id)).size).toBe(43);
  });

  test('distinguishes accounts sharing name and prefix; current names, missing and unknown remain distinct', async () => {
    const { caller, db, event } = fixture(a);
    db.securityEvent.findMany.mockResolvedValue([
      { ...event, id: 'a', actorId: a },
      { ...event, id: 'b', actorId: b },
      { ...event, id: 'missing', actorId: missing },
      { ...event, id: 'legacy', actorId: 'legacy' },
      { ...event, id: 'unknown', actorId: null as unknown as string },
    ]);
    db.user.findMany.mockResolvedValue([
      { id: a, name: 'Гость', email: 'one@mail.ru' },
      { id: b, name: 'Гость', email: 'two@mail.ru' },
    ]);
    const result = await caller.admin.getSecurityEvents({ limit: 20 });
    expect(result.items.map((x) => x.actor)).toEqual([
      { name: 'Гость', email: 'one@mail.ru', isOwner: true },
      { name: 'Гость', email: 'two@mail.ru', isOwner: false },
      null,
      null,
      null,
    ]);
    expect(result.items.map((x) => x.actorId)).toEqual([a, b, missing, 'legacy', null]);
    db.user.findMany.mockResolvedValue([{ id: a, name: 'Новое имя', email: 'one@mail.ru' }]);
    const changed = await caller.admin.getSecurityEvents({ limit: 20 });
    expect(changed.items[0]?.actor?.name).toBe('Новое имя');
    expect(changed.items[0]?.actorId).toBe(a);
  });

  test('missing account is still searchable; malformed UUID is rejected before the journal query', async () => {
    const { caller, db, event } = fixture('owner');
    for (const value of ['', 'abc', 'example@mail.ru', a.slice(0, 8), a + 'x']) {
      await expect(caller.admin.getSecurityEvents({ actorId: value })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(caller.admin.getSecurityEvents({ actorId: a, direction: 'backward' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(caller.admin.getSecurityEvents({ actorId: a, arbitrary: true } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.securityEvent.findMany).not.toHaveBeenCalled();
    db.securityEvent.findMany.mockResolvedValue([{ ...event, actorId: missing }]);
    db.user.findMany.mockResolvedValue([]);
    expect((await caller.admin.getSecurityEvents({ actorId: missing })).items[0]).toMatchObject({
      actorId: missing,
      actor: null,
    });
    db.securityEvent.findMany.mockResolvedValue([]);
    expect(await caller.admin.getSecurityEvents({ actorId: b })).toEqual({ items: [], nextCursor: undefined });
  });

  test('filter never bypasses owner, guest or impersonation policy', async () => {
    for (const [id, impersonation, code] of [
      ['ordinary', null, 'FORBIDDEN'],
      [null, null, 'UNAUTHORIZED'],
      ['owner', { adminId: 'owner', targetId: 'ordinary' }, 'FORBIDDEN'],
    ] as const) {
      const { caller, db } = fixture(id, impersonation);
      requireOwner.mockRejectedValue(new AppError('FORBIDDEN'));
      await expect(caller.admin.getSecurityEvents({ actorId: a })).rejects.toMatchObject({ code });
      expect(db.securityEvent.findMany).not.toHaveBeenCalled();
      expect(db.user.findMany).not.toHaveBeenCalled();
    }
  });
});
