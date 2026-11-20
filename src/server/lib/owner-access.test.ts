import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { requireOwner } from './owner-access';

function scenario() {
  const user = {
    email: 'owner@mail.ru',
    emailVerified: new Date('2026-11-13T10:00:00Z') as Date | null,
    suspendedAt: null as Date | null,
    isPlaceholder: false,
    sessionSecurityVersion: 0,
  };
  const record = {
    userId: 'real-owner',
    completedAt: new Date('2026-11-13T10:00:00Z') as Date | null,
  };
  const db = {
    user: { findUnique: vi.fn(async () => user) },
    ownerBootstrap: { findUnique: vi.fn(async () => record) },
  };
  return { user, record, db, client: db as unknown as PrismaClient };
}

describe('Issue #1 6.12.2: central owner policy fails closed', () => {
  it('authorizes only the exact finished singleton and current verified, active account', async () => {
    const { client, db } = scenario();
    await expect(requireOwner(client, 'real-owner')).resolves.toBe('real-owner');
    expect(db.ownerBootstrap.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { userId: true, completedAt: true },
    });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'real-owner' },
      select: {
        email: true,
        emailVerified: true,
        suspendedAt: true,
        isPlaceholder: true,
        sessionSecurityVersion: true,
      },
    });
  });

  it('rejects absent sessions before any database lookup', async () => {
    for (const id of [null, undefined, '']) {
      const { client, db } = scenario();
      await expect(requireOwner(client, id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.ownerBootstrap.findUnique).not.toHaveBeenCalled();
      expect(db.user.findUnique).not.toHaveBeenCalled();
    }
  });

  it('rejects matching email, client owner role and forged identity when user ID differs', async () => {
    const { client } = scenario();
    await expect(requireOwner(client, 'regular-user')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(requireOwner(client, 'real-owner-extra')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects missing or incomplete singleton registration', async () => {
    const missing = scenario();
    missing.db.ownerBootstrap.findUnique.mockResolvedValueOnce(null as never);
    await expect(requireOwner(missing.client, 'real-owner')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const pending = scenario();
    pending.record.completedAt = null;
    await expect(requireOwner(pending.client, 'real-owner')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects unverified, suspended and placeholder owners even with the correct ID', async () => {
    for (const state of [
      { emailVerified: null },
      { suspendedAt: new Date('2026-11-13T11:00:00Z') },
      { isPlaceholder: true },
    ]) {
      const { client, user } = scenario();
      Object.assign(user, state);
      await expect(requireOwner(client, 'real-owner')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('6.14.2: a legacy owner with a forbidden DNS zone cannot regain admin permissions', async () => {
    for (const email of ['owner@example.com', 'owner@mail.ru.evil.com']) {
      const { client, user } = scenario();
      user.email = email;
      await expect(requireOwner(client, 'real-owner')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('rejects missing or invalid session security versions and database errors', async () => {
    for (const value of [-1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const { client, user } = scenario();
      user.sessionSecurityVersion = value;
      await expect(requireOwner(client, 'real-owner')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const unavailable = scenario();
    unavailable.db.user.findUnique.mockRejectedValueOnce(Error('DB unavailable'));
    await expect(requireOwner(unavailable.client, 'real-owner')).rejects.toThrow();
  });

  it('6.12.10: the post-Prisma PostgreSQL guard protects both owner rows, not just the singleton pointer', () => {
    const sql = readFileSync('prisma/after-push/owner_bootstrap_identity_guard.sql', 'utf8');
    expect(sql).toContain('billok_owner_bootstrap_guard_row');
    expect(sql).toContain('billok_owner_bootstrap_guard_truncate');
    expect(sql).toContain('billok_owner_user_row_guard');
    expect(sql).toContain('billok_user_id_immutable');
    expect(sql).toContain('billok_owner_account_immutable');
    expect(sql).toContain('billok_owner_passkey_required');
    expect(sql).toContain('NEW."emailVerified" IS DISTINCT FROM OLD."emailVerified"');
    expect(sql).toContain('NEW."webAuthnUserHandle" IS DISTINCT FROM OLD."webAuthnUserHandle"');
    const ci = readFileSync('.github/workflows/billok-ci.yml', 'utf8');
    expect(ci).toContain('scripts/qa-owner-bootstrap-phase-postgres.sql');
    expect(ci).toContain('scripts/qa-owner-identity-postgres.sql');
  });

  it('forces EVERY administrative entrypoint through requireOwner, not ADMIN_EMAIL', () => {
    const routes = [
      'src/server/trpc/routers/admin.ts',
      'src/app/api/admin/export/route.ts',
      'src/app/api/admin/impersonate/route.ts',
      'src/app/[locale]/(app)/admin/users/page.tsx',
      'src/app/[locale]/(app)/layout.tsx',
      'src/app/api/webauthn/owner/add/start/route.ts',
      'src/app/api/webauthn/owner/add/finish/route.ts',
      'src/app/api/webauthn/owner/approval/start/route.ts',
      'src/app/api/webauthn/owner/approval/finish/route.ts',
      'src/app/api/webauthn/owner/manage/rename/route.ts',
      'src/app/api/webauthn/owner/manage/revoke/route.ts',
    ];
    for (const path of routes) {
      const code = readFileSync(path, 'utf8');
      expect(code, path).toContain('requireOwner(');
      expect(code, path).not.toMatch(/process\.env\.ADMIN_EMAIL|\bisCompletedOwner\(/u);
    }
    // The old two-step revoke routes are deliberately NOT live owner
    // entrypoints: even an authenticated owner cannot invoke that bypass.
    for (const phase of ['start', 'finish']) {
      const retired = readFileSync('src/app/api/webauthn/owner/revoke/' + phase + '/route.ts', 'utf8');
      expect(retired).toContain('status: 410');
      expect(retired).not.toContain('finishOwnerPasskeyRevocation');
      expect(retired).not.toContain('beginOwnerPasskeyRevocation');
    }
    // Initial owner setup intentionally works before completedAt exists; status
    // never writes any privileged data and still verifies signed session + ID.
    const bootstrap = readFileSync('src/app/api/webauthn/owner/bootstrap/status/route.ts', 'utf8');
    expect(bootstrap).toContain('owner.userId !== session.user.id');
    const auth = readFileSync('src/server/auth.ts', 'utf8');
    expect(auth).toContain('fresh.sessionSecurityVersion');
    expect(auth).toContain('sessionSecurityValid');
  });
});
