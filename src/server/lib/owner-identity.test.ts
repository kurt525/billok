import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@/generated/prisma/client';
import { completedOwnerUserId, isCompletedOwner } from './owner-identity';

const makeDb = (userId: string | null = 'owner-1', completed = true) => ({
  ownerBootstrap: {
    findUnique: vi.fn().mockResolvedValue(
      userId
        ? {
            userId,
            completedAt: completed ? new Date('2026-11-13T00:00:00Z') : null,
          }
        : null,
    ),
  },
});
const asDb = (value: ReturnType<typeof makeDb>) => value as unknown as PrismaClient;

describe('Issue #1 6.12.1: only completed DB bootstrap User.id can grant owner role', () => {
  it('binds the owner to fixed row 1 and refuses uninitialized setup', async () => {
    const db = makeDb('owner-1');
    expect(await completedOwnerUserId(asDb(db))).toBe('owner-1');
    expect(db.ownerBootstrap.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { userId: true, completedAt: true },
    });
    expect(await completedOwnerUserId(asDb(makeDb(null)))).toBeNull();
    expect(await completedOwnerUserId(asDb(makeDb('owner-1', false)))).toBeNull();
  });
  it('ignores any equality of user emails or forged JWT role; compares only trusted session ID', async () => {
    const db = asDb(makeDb());
    expect(await isCompletedOwner(db, 'owner-1')).toBe(true);
    expect(await isCompletedOwner(db, 'other-user')).toBe(false);
    expect(await isCompletedOwner(db, 'owner-1-suffix')).toBe(false);
    expect(await isCompletedOwner(db, '')).toBe(false);
    expect(await isCompletedOwner(db, undefined)).toBe(false);
    expect(await isCompletedOwner(db, null)).toBe(false);
  });
  it('no administrative route, privileged menu or guest-name exemption reads ADMIN_EMAIL', () => {
    for (const filename of [
      'src/server/trpc/routers/admin.ts',
      'src/server/trpc/routers/guest.ts',
      'src/app/api/admin/export/route.ts',
      'src/app/api/admin/impersonate/route.ts',
      'src/app/[locale]/(app)/layout.tsx',
    ]) {
      const source = readFileSync(filename, 'utf8');
      expect(source, filename).not.toMatch(/process\.env\.ADMIN_EMAIL|env\.ADMIN_EMAIL/u);
    }
  });

  it('PostgreSQL enforces singleton ID and immutability independently of any application check', () => {
    const guard = readFileSync('prisma/after-push/owner_bootstrap_identity_guard.sql', 'utf8');
    const qa = readFileSync('scripts/qa-owner-identity-postgres.sql', 'utf8');
    const deploy = readFileSync('docker/entrypoint.sh', 'utf8');
    expect(guard).toContain('CHECK (id = 1)');
    expect(guard).toContain('NEW."userId" IS DISTINCT FROM OLD."userId"');
    expect(guard).toContain('NEW.id IS DISTINCT FROM OLD.id');
    expect(guard).toContain('BEFORE UPDATE OR DELETE');
    expect(guard).toContain('BEFORE TRUNCATE');
    expect(qa).toContain('billok_owner_identity_immutable');
    expect(qa).toContain('UPDATE public."OwnerBootstrap" SET "userId"');
    expect(qa).toContain('INSERT INTO public."OwnerBootstrap"');
    expect(deploy).toContain('for sqlfile in /app/prisma/after-push/*.sql');
  });

  it('never checks any source of admin privilege for a missing session identity', async () => {
    const db = makeDb();
    expect(await isCompletedOwner(asDb(db), undefined)).toBe(false);
    expect(db.ownerBootstrap.findUnique).not.toHaveBeenCalled();
  });
});
