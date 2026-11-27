import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('BillOK release metadata', () => {
  it('uses a synchronized independent numeric version in both package manifests', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    expect(pkg.version).toMatch(/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
    const release = JSON.parse(readFileSync('src/server/lib/billok-release.json', 'utf8'));
    expect(release).toMatchObject({
      schemaVersion: 1,
      version: pkg.version,
      taskId: expect.stringMatching(/^TASK-BILLOK-\d{3,}$/),
      taskTitle: expect.any(String),
      pullRequest: expect.any(Number),
    });
    expect(release.taskTitle.trim()).not.toBe('');
    expect(Number.isSafeInteger(release.pullRequest)).toBe(true);
    expect(release.pullRequest).toBeGreaterThan(0);
  });

  it('retains the owner-only server gate for the displayed build information', () => {
    const admin = readFileSync('src/server/trpc/routers/admin.ts', 'utf8');
    expect(admin).toContain('getSystemHealth: adminProcedure.query');
    expect(admin).toContain('await requireOwner(ctx.db, ctx.user.id)');
    expect(admin).toContain("if (ctx.impersonating) throw new AppError('FORBIDDEN', 'adminRequired')");
  });
});
